const { pool } = require("../config/db");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const config = require("../config/config");

const handleError = (res, error, defaultMessage = "Internal server error") => {
  console.error(error);
  return res.status(error.status || 500).json({
    success: false,
    message: error.message || defaultMessage,
  });
};

exports.changePassword = async (req, res) => {
  const { email, newPassword } = req.body;

  if (!email || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Email and new password are required.",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [user] = await connection.query(
      "SELECT 'users' AS table_name, password_hash FROM users WHERE email = ? UNION ALL SELECT 'admins', password_hash FROM admins WHERE email = ?",
      [email, email]
    );

    if (!user.length) {
      return res
        .status(404)
        .json({ success: false, message: "Email not found." });
    }

    const { table_name, password_hash } = user[0];

    const isSamePassword = await bcrypt.compare(newPassword, password_hash);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: "New password cannot be the same as the old password.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await connection.query(
      `UPDATE ${table_name} SET password_hash = ? WHERE email = ?`,
      [hashedPassword, email]
    );

    return res.status(200).json({
      success: true,
      message: "Password has been reset successfully.",
    });
  } catch (error) {
    return handleError(res, error);
  } finally {
    if (connection) connection.release();
  }
};

exports.getAllUsers = async (req, res) => {
  const { search, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  try {
    let query = "SELECT * FROM view_users";
    const queryParams = [];

    if (search) {
      query +=
        " WHERE id_number LIKE ? OR first_name LIKE ? OR middle_name LIKE ? OR last_name LIKE ? OR suffix LIKE ? OR email LIKE ? OR role_name LIKE ? OR block_name LIKE ? OR course_name LIKE ? OR department_code LIKE ? OR year_level_name LIKE ?";
      queryParams.push(
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`
      );
    }

    query += " LIMIT ? OFFSET ?";
    queryParams.push(parseInt(limit), parseInt(offset));

    const [users] = await pool.query(query, queryParams);

    const countQuery = search
      ? `
        SELECT COUNT(*) AS total 
        FROM view_users 
        WHERE id_number LIKE ? OR first_name LIKE ? OR middle_name LIKE ? OR last_name LIKE ? OR suffix LIKE ? OR email LIKE ? OR role_name LIKE ? OR block_name LIKE ? OR course_name LIKE ? OR department_code LIKE ? OR year_level_name LIKE ?
      `
      : "SELECT COUNT(*) AS total FROM view_users";
    const countParams = search
      ? [
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
        ]
      : [];
    const [totalCountResult] = await pool.query(countQuery, countParams);
    const total = totalCountResult[0].total;

    if (!users.length) {
      return res.status(404).json({
        success: false,
        message: "No users found",
      });
    }

    return res.status(200).json({
      success: true,
      data: users,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.getUserByID = async (req, res) => {
  const id_number = req.params.id;
  let connection;

  try {
    connection = await pool.getConnection();

    const [user] = await connection.query(
      "SELECT * FROM view_users WHERE id_number = ?",
      [id_number]
    );

    if (user.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      user: user[0],
    });
  } catch (error) {
    return handleError(res, error);
  } finally {
    if (connection) connection.release();
  }
};

exports.editUser = async (req, res) => {
  const id_number = req.params.id;
  const { first_name, last_name, email, role_id, block_id, status, suffix } =
    req.body;

  if (
    !id_number ||
    !first_name ||
    !last_name ||
    !role_id ||
    !block_id ||
    !status
  ) {
    return res.status(400).json({
      success: false,
      message:
        "All fields (id_number, first_name, last_name, email, role_id, block_id, status) are required.",
    });
  }

  const finalEmail = status === "Unregistered" && !email ? null : email;

  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(
      "UPDATE users SET first_name = ?, last_name = ?, email = ?, role_id = ?, block_id = ?, status = ?, suffix = ? WHERE id_number = ?",
      [
        first_name,
        last_name,
        finalEmail,
        role_id,
        block_id,
        status,
        suffix || null,
        id_number,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "User details updated successfully.",
    });
  } catch (error) {
    return handleError(res, error);
  } finally {
    if (connection) connection.release();
  }
};

exports.disableUser = async (req, res) => {
  const id_number = req.params.id;
  let connection;

  try {
    connection = await pool.getConnection();

    const [userResult] = await connection.query(
      "SELECT id_number, email, first_name, last_name FROM users WHERE id_number = ?",
      [id_number]
    );

    if (userResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const user = userResult[0];

    const [result] = await connection.query(
      "UPDATE users SET status = 'Disabled' WHERE id_number = ?",
      [id_number]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const io = req.app.get("io");

    if (io) {
      const eventData = {
        userId: id_number.toString(),
        id_number: id_number.toString(),
        email: user.email,
        name: `${user.first_name} ${user.last_name}`,
        timestamp: new Date(),
      };

      io.emit("user-disabled", eventData);
    }

    return res.status(200).json({
      success: true,
      message: "User disabled successfully.",
      user: user,
    });
  } catch (error) {
    return handleError(res, error);
  } finally {
    if (connection) connection.release();
  }
};

exports.addUser = async (req, res) => {
  const {
    id_number,
    role_id,
    block_id,
    first_name,
    middle_name,
    last_name,
    suffix,
  } = req.body;

  if (!id_number || !role_id || !block_id || !first_name || !last_name) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [existingUser] = await connection.query(
      "SELECT * FROM users WHERE id_number = ?",
      [id_number]
    );

    if (existingUser.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A user with this ID number already exists.",
      });
    }

    const [role] = await connection.query("SELECT id FROM roles WHERE id = ?", [
      role_id,
    ]);
    if (!role.length) {
      return res.status(400).json({
        success: false,
        message: "Invalid role_id. Role does not exist.",
      });
    }

    const [block] = await connection.query(
      "SELECT id FROM blocks WHERE id = ?",
      [block_id]
    );
    if (!block.length) {
      return res.status(400).json({
        success: false,
        message: "Invalid block_id. Block does not exist.",
      });
    }

    const query = `
      INSERT INTO users (
        id_number, role_id, block_id, first_name, middle_name, 
        last_name, suffix, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Unregistered')
    `;

    await connection.query(query, [
      id_number,
      role_id,
      block_id,
      first_name,
      middle_name || null,
      last_name,
      suffix || null,
    ]);

    return res.status(201).json({
      success: true,
      message: "User added successfully.",
    });
  } catch (error) {
    console.error("Error in addUser function:", {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
      timestamp: new Date().toISOString(),
    });

    return res.status(500).json({
      success: false,
      message: "Failed to add user",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
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
