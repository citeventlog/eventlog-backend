const { pool } = require("../config/db");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const config = require("../config/config");

const handleError = (res, error, defaultMessage = "Internal server error") => {
  console.error(error);
  return res.status(error.status || 500).json({
    success: false,
    message: error.message || defaultMessage,
  });
};

exports.getAllAdmins = async (req, res) => {
  try {
    const searchQuery = req.query.search || "";

    const query = `
      SELECT * FROM view_admins
      WHERE id_number LIKE ? 
         OR first_name LIKE ? 
         OR last_name LIKE ? 
         OR email LIKE ?
    `;

    const searchTerm = `%${searchQuery}%`;
    const [admins] = await pool.query(query, [
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
    ]);

    if (!admins.length) {
      return res
        .status(404)
        .json({ success: false, message: "No admins found" });
    }

    return res.status(200).json({ success: true, admins });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.disableAdmin = async (req, res) => {
  try {
    const { id_number } = req.params;

    const [rows] = await pool.query(
      "SELECT * FROM admins WHERE id_number = ?",
      [id_number]
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Admin not found" });
    }

    await pool.query(
      "UPDATE admins SET status = 'Disabled' WHERE id_number = ?",
      [id_number]
    );

    return res.status(200).json({
      success: true,
      message: "Admin disabled successfully",
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.addAdmin = async (req, res) => {
  const {
    id_number,
    first_name,
    middle_name,
    last_name,
    suffix,
    email,
    role_id,
  } = req.body;

  if (!id_number || !first_name || !last_name) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  const validRoles = [3, 4];
  const selectedRoleId = role_id || 3;

  if (!validRoles.includes(selectedRoleId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid role_id. Must be 3 (Admin) or 4 (Super Admin)",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [existingAdmin] = await connection.query(
      "SELECT * FROM admins WHERE id_number = ?",
      [id_number]
    );

    if (existingAdmin.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Admin with this ID number already exists",
      });
    }

    if (email) {
      const [existingEmail] = await connection.query(
        "SELECT * FROM admins WHERE email = ?",
        [email]
      );

      if (existingEmail.length > 0) {
        return res.status(409).json({
          success: false,
          message: "An admin with this email already exists",
        });
      }
    }

    const generatedPassword = crypto.randomBytes(6).toString("hex");

    const saltRounds = 10;
    const password_hash = await bcrypt.hash(generatedPassword, saltRounds);

    const query = `
      INSERT INTO admins (
        id_number, role_id, first_name, middle_name, 
        last_name, suffix, email, password_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await connection.query(query, [
      id_number,
      selectedRoleId,
      first_name,
      middle_name || null,
      last_name,
      suffix || null,
      email || null,
      password_hash,
    ]);

    if (email) {
      sendCredentials(email, id_number, generatedPassword);
    }

    return res.status(201).json({
      success: true,
      message: "Admin added successfully. Login credentials sent to email.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to add admin",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

const sendCredentials = async (email, id_number, password) => {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com",
      port: 465,
      secure: true,
      auth: { user: config.EMAIL_USER, pass: config.EMAIL_PASS },
    });

    await transporter.sendMail({
      from: '"Eventlog" <eventlogucv@zohomail.com>',
      to: email,
      subject: "Your Login Credentials",
      text: `Your ID Number is: ${id_number}\nYour initial password is: ${password}`,
      html: `
        <p>Your ID Number is: <b>${id_number}</b></p>
        <p>Your initial password is: <b>${password}</b></p>
        <p>Please log in and change your password immediately.</p>
      `,
    });
  } catch (error) {
    console.error("Error sending email:", error);
  }
};

exports.editAdmin = async (req, res) => {
  const { id_number } = req.params;
  const {
    new_id_number,
    department_id,
    first_name,
    last_name,
    suffix,
    email,
    role_id,
    status,
  } = req.body;

  let connection;
  try {
    connection = await pool.getConnection();

    await connection.beginTransaction();

    const [existingAdmin] = await connection.query(
      "SELECT * FROM admins WHERE id_number = ?",
      [id_number]
    );
    if (!existingAdmin.length) {
      return res
        .status(404)
        .json({ success: false, message: "Admin not found" });
    }

    if (new_id_number !== undefined) {
      const [existingIdNumber] = await connection.query(
        "SELECT * FROM admins WHERE id_number = ? AND id_number != ?",
        [new_id_number, id_number]
      );
      if (existingIdNumber.length > 0) {
        return res.status(409).json({
          success: false,
          message: "An admin with this ID number already exists",
        });
      }
    }

    if (new_id_number !== undefined) {
      await connection.query(
        "UPDATE events SET approved_by = ? WHERE approved_by = ?",
        [new_id_number, id_number]
      );
    }

    const updates = [];
    const params = [];

    if (new_id_number !== undefined) {
      updates.push("id_number = ?");
      params.push(new_id_number);
    }
    if (department_id !== undefined) {
      updates.push("department_id = ?");
      params.push(department_id);
    }
    if (first_name !== undefined) {
      updates.push("first_name = ?");
      params.push(first_name);
    }
    if (last_name !== undefined) {
      updates.push("last_name = ?");
      params.push(last_name);
    }
    if (suffix !== undefined) {
      updates.push("suffix = ?");
      params.push(suffix || null);
    }
    if (email !== undefined) {
      updates.push("email = ?");
      params.push(email || null);
    }
    if (role_id !== undefined) {
      updates.push("role_id = ?");
      params.push(role_id);
    }
    if (status !== undefined) {
      updates.push("status = ?");
      params.push(status);
    }

    if (updates.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No fields provided for update" });
    }

    params.push(id_number);

    const query = `
      UPDATE admins 
      SET ${updates.join(", ")} 
      WHERE id_number = ?
    `;

    await connection.query(query, params);

    await connection.commit();

    return res
      .status(200)
      .json({ success: true, message: "Admin updated successfully" });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(500).json({
      success: false,
      message: "Failed to update admin",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

exports.fetchAdminById = async (req, res) => {
  try {
    const { id_number } = req.params;

    const [admin] = await pool.query(
      "SELECT * FROM view_admins WHERE id_number = ?",
      [id_number]
    );

    if (!admin.length) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    return res.status(200).json({
      success: true,
      admin: admin[0],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch admin details",
      error: error.message,
    });
  }
};
