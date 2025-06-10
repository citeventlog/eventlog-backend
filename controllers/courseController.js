const { pool } = require("../config/db");

const handleError = (res, error, defaultMessage = "Internal server error") => {
  console.error(error);
  return res.status(error.status || 500).json({
    success: false,
    message: error.message || defaultMessage,
  });
};

exports.getAllCourses = async (req, res) => {
  try {
    const searchQuery = req.query.search || "";

    const query = `
      SELECT * FROM view_courses 
      WHERE course_name LIKE ? OR department_name LIKE ?
    `;

    const searchTerm = `%${searchQuery}%`;
    const [courses] = await pool.query(query, [searchTerm, searchTerm]);

    if (!courses.length) {
      return res
        .status(404)
        .json({ success: false, message: "No courses found" });
    }

    return res.status(200).json({ success: true, courses });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.disableCourse = async (req, res) => {
  try {
    const { id } = req.params;

    const [course] = await pool.query(
      "SELECT * FROM view_courses WHERE course_id = ?",
      [id]
    );

    if (!course.length) {
      return res
        .status(404)
        .json({ success: false, message: "Course not found" });
    }

    await pool.query("UPDATE courses SET status = 'Disabled' WHERE id = ?", [
      id,
    ]);

    return res.status(200).json({
      success: true,
      message: "Course marked as deleted successfully",
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.addCourse = async (req, res) => {
  const { course_name, course_code, department_id } = req.body;

  if (!course_name || !department_id || !course_code) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [existingCourse] = await connection.query(
      "SELECT * FROM view_courses WHERE LOWER(course_name) = ? OR LOWER(course_code) = ?",
      [course_name.toLowerCase(), course_code.toLowerCase()]
    );

    if (existingCourse.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A course with this name already exists",
      });
    }

    const query = `
        INSERT INTO courses (
          name, code, department_id
        ) VALUES (?, ?, ?)
      `;

    await connection.query(query, [course_name, course_code, department_id]);

    return res.status(201).json({
      success: true,
      message: "Course added successfully",
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      success: false,
      message: "Failed to add course",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

exports.editCourse = async (req, res) => {
  const { id } = req.params;
  const { name, department_id, status, course_code } = req.body;

  if (!name || !department_id || !status || !course_code) {
    return res.status(400).json({
      success: false,
      message:
        "All fields (name, department_id, status, course_code) are required",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [existingCourse] = await connection.query(
      "SELECT * FROM courses WHERE id = ?",
      [id]
    );

    if (!existingCourse.length) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    const query = `
        UPDATE courses 
        SET name = ?, department_id = ?, status = ?, code = ? 
        WHERE id = ?
      `;

    await connection.query(query, [
      name,
      department_id,
      status,
      course_code,
      id,
    ]);

    return res.status(200).json({
      success: true,
      message: "Course updated successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update course",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

exports.fetchCourseById = async (req, res) => {
  try {
    const { id } = req.params;

    const [course] = await pool.query(
      "SELECT * FROM view_courses WHERE course_id = ?",
      [id]
    );

    if (!course.length) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    return res.status(200).json({
      success: true,
      course: course[0],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch course details",
      error: error.message,
    });
  }
};

exports.getCoursesByDepartmentId = async (req, res) => {
  try {
    const { department_id } = req.params;

    if (!department_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required field: department_id",
      });
    }

    const query = `
      SELECT * FROM view_courses 
      WHERE department_id = ? AND status = 'Active'
    `;

    const [courses] = await pool.query(query, [department_id]);

    if (!courses.length) {
      return res.status(404).json({
        success: false,
        message: "No active courses found for this department",
      });
    }

    return res.status(200).json({
      success: true,
      courses,
    });
  } catch (error) {
    return handleError(res, error, "Failed to fetch courses by department ID");
  }
};
