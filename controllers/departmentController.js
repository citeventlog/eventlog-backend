const { pool } = require("../config/db");

const handleError = (res, error, defaultMessage = "Internal server error") => {
  console.error(error);
  return res.status(error.status || 500).json({
    success: false,
    message: error.message || defaultMessage,
  });
};

exports.getDepartments = async (req, res) => {
  try {
    const searchQuery = req.query.search || "";

    const query = `
        SELECT * FROM view_departments 
        WHERE department_name LIKE ? OR department_code LIKE ?
      `;

    const searchTerm = `%${searchQuery}%`;

    const [departments] = await pool.query(query, [searchTerm, searchTerm]);

    if (!departments.length) {
      return res
        .status(404)
        .json({ success: false, message: "No departments found" });
    }

    return res.status(200).json({ success: true, departments });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.getDepartmentById = async (req, res) => {
  const { id } = req.params;
  try {
    const [departments] = await pool.query(
      "SELECT * FROM view_departments WHERE department_id = ?",
      [id]
    );
    if (!departments.length) {
      return res
        .status(404)
        .json({ success: false, message: "Department not found" });
    }
    return res.status(200).json({ success: true, department: departments[0] });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.addDepartment = async (req, res) => {
  const { department_name, department_code } = req.body;
  try {
    if (!department_name || !department_code) {
      return res.status(400).json({
        success: false,
        message: "Department name and code are required",
      });
    }
    const [result] = await pool.query(
      "INSERT INTO departments (name, code) VALUES (?, ?)",
      [department_name, department_code]
    );
    const newDepartmentId = result.insertId;
    return res.status(201).json({
      success: true,
      message: "Department added successfully",
      department: {
        department_id: newDepartmentId,
        department_name,
        department_code,
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.updateDepartment = async (req, res) => {
  const { id } = req.params;
  const { department_name, department_code, status } = req.body;
  try {
    const [departments] = await pool.query(
      "SELECT * FROM departments WHERE id = ?",
      [id]
    );
    if (!departments.length) {
      return res
        .status(404)
        .json({ success: false, message: "Department not found" });
    }
    await pool.query(
      "UPDATE departments SET name = ?, code = ?, status = ? WHERE id = ?",
      [department_name, department_code, status, id]
    );
    return res.status(200).json({
      success: true,
      message: "Department updated successfully",
      department: { department_id: id, department_name, department_code },
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.disableDepartment = async (req, res) => {
  const { id } = req.params;

  try {
    const [departments] = await pool.query(
      "SELECT * FROM departments WHERE id = ?",
      [id]
    );

    if (!departments.length) {
      return res
        .status(404)
        .json({ success: false, message: "Department not found" });
    }

    await pool.query("UPDATE departments SET status = ? WHERE id = ?", [
      "Disabled",
      id,
    ]);

    return res.status(200).json({
      success: true,
      message: "Department Disabled successfully",
    });
  } catch (error) {
    return handleError(res, error);
  }
};
