const { pool } = require("../config/db");
const csv = require("csv-parser");
const fs = require("fs");

const updateStudents = async (filePath) => {
  const connection = await pool.getConnection();

  try {
    await connection.query("START TRANSACTION");

    const rows = [];
    const processedIdNumbers = new Set();

    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(
          csv({
            mapHeaders: ({ header }) => header.toLowerCase().replace(/ /g, "_"),
          })
        )
        .on("data", (row) => {
          if (row.id_number && row.id_number.trim() !== "") {
            rows.push(row);
            processedIdNumbers.add(row.id_number);
          }
        })
        .on("end", () => {
          resolve();
        })
        .on("error", (err) => {
          reject(err);
        });
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const {
        id_number,
        department,
        course,
        block,
        year_level,
        first_name,
        middle_name,
        last_name,
        suffix,
      } = row;

      const userQuery = "SELECT * FROM users WHERE id_number = ?";
      const userValues = [id_number];
      const [userResult] = await connection.query(userQuery, userValues);

      let blockId;
      const blockQuery = `
        SELECT id FROM blocks
        WHERE name = ? AND department_id = (
          SELECT id FROM departments WHERE code = ?
        ) AND course_id = (
          SELECT id FROM courses WHERE code = ?
        ) AND year_level_id = ? AND school_year_semester_id = (
          SELECT id FROM school_year_semesters WHERE status = 'Active'
        )
      `;
      const blockValues = [block, department, course, year_level];
      const [blockResult] = await connection.query(blockQuery, blockValues);

      if (blockResult.length === 0) {
        const departmentQuery = "SELECT id FROM departments WHERE code = ?";
        const departmentValues = [department];
        const [departmentResult] = await connection.query(
          departmentQuery,
          departmentValues
        );
        if (departmentResult.length === 0) continue;

        const courseQuery = "SELECT id FROM courses WHERE code = ?";
        const courseValues = [course];
        const [courseResult] = await connection.query(
          courseQuery,
          courseValues
        );
        if (courseResult.length === 0) continue;

        const insertBlockQuery = `
          INSERT INTO blocks (name, department_id, course_id, year_level_id, school_year_semester_id)
          VALUES (?, ?, ?, ?, (SELECT id FROM school_year_semesters WHERE status = 'Active'))
        `;
        const insertBlockValues = [
          block,
          departmentResult[0].id,
          courseResult[0].id,
          year_level,
        ];
        const [insertBlockResult] = await connection.query(
          insertBlockQuery,
          insertBlockValues
        );
        blockId = insertBlockResult.insertId;
      } else {
        blockId = blockResult[0].id;
      }

      if (userResult.length > 0) {
        const updateQuery = `
          UPDATE users
          SET block_id = ?,
              first_name = ?,
              middle_name = ?,
              last_name = ?,
              suffix = ?,
              status = CASE WHEN status != 'Unregistered' THEN 'Active' ELSE status END
          WHERE id_number = ?
        `;
        const updateValues = [
          blockId,
          first_name,
          middle_name || null,
          last_name,
          suffix || null,
          id_number,
        ];
        await connection.query(updateQuery, updateValues);
      } else {
        const insertQuery = `
          INSERT INTO users (id_number, block_id, first_name, middle_name, last_name, suffix, status)
          VALUES (?, ?, ?, ?, ?, ?, 'Unregistered')
        `;
        const insertValues = [
          id_number,
          blockId,
          first_name,
          middle_name || null,
          last_name,
          suffix || null,
        ];
        await connection.query(insertQuery, insertValues);
      }
    }

    const disableQuery = `
      UPDATE users
      SET status = 'Disabled'
      WHERE id_number NOT IN (?) AND status = 'Active'
    `;
    const disableValues = [Array.from(processedIdNumbers)];
    await connection.query(disableQuery, disableValues);

    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
};

async function changeSchoolYear(filePath) {
  const connection = await pool.getConnection();

  function normalizeBlockName(name) {
    return name.trim().toUpperCase().replace(/\s+/g, " ");
  }

  try {
    await connection.query("START TRANSACTION");

    const [currentSemesterResult] = await connection.query(
      `SELECT id, school_year, semester FROM school_year_semesters WHERE status = 'Active'`
    );
    if (currentSemesterResult.length === 0)
      throw new Error("No active semester found");

    const {
      id: currentSemesterId,
      school_year,
      semester,
    } = currentSemesterResult[0];

    await populateAttendanceForCurrentSemester(connection, currentSemesterId);

    await connection.query(
      `UPDATE school_year_semesters SET status = 'Archived' WHERE id = ?`,
      [currentSemesterId]
    );

    let newSchoolYear = school_year;
    let newSemester = "";
    if (semester === "1st Semester") newSemester = "2nd Semester";
    else if (semester === "2nd Semester") {
      const [yearStart, yearEnd] = school_year.split("-");
      newSchoolYear = `${yearEnd}-${Number(yearEnd) + 1}`;
      newSemester = "1st Semester";
    }

    const [insertNewSemester] = await connection.query(
      `INSERT INTO school_year_semesters (school_year, semester, status) VALUES (?, ?, 'Active')`,
      [newSchoolYear, newSemester]
    );
    const newSemesterId = insertNewSemester.insertId;

    await connection.query(
      `UPDATE blocks SET status = 'Archived' WHERE school_year_semester_id = ?`,
      [currentSemesterId]
    );

    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(
          csv({
            mapHeaders: ({ header }) => header.toLowerCase().replace(/ /g, "_"),
          })
        )
        .on("data", (row) => rows.push(row))
        .on("end", resolve)
        .on("error", reject);
    });

    const blockCache = new Map();

    for (const row of rows) {
      const departmentCode = row.department.trim();
      const courseCode = row.course.trim();
      const blockRaw = row.block;
      const blockName = normalizeBlockName(blockRaw);
      const yearLevelId = row.year_level.trim();

      const blockKey = `${departmentCode}-${courseCode}-${blockName}-${yearLevelId}`;

      let blockId = blockCache.get(blockKey);
      if (!blockId) {
        const [blockResult] = await connection.query(
          `SELECT b.id FROM blocks b
           JOIN departments d ON b.department_id = d.id
           JOIN courses c ON b.course_id = c.id
           WHERE d.code = ? AND c.code = ? AND b.name = ? AND b.year_level_id = ? AND b.school_year_semester_id = ? AND b.status = 'Active'
           LIMIT 1`,
          [departmentCode, courseCode, blockName, yearLevelId, newSemesterId]
        );

        if (blockResult.length > 0) {
          blockId = blockResult[0].id;
        } else {
          const [deptResult] = await connection.query(
            "SELECT id FROM departments WHERE code = ? LIMIT 1",
            [departmentCode]
          );
          if (deptResult.length === 0) continue;
          const departmentId = deptResult[0].id;

          const [courseResult] = await connection.query(
            "SELECT id FROM courses WHERE code = ? LIMIT 1",
            [courseCode]
          );
          if (courseResult.length === 0) continue;
          const courseId = courseResult[0].id;

          const [yearLevelResult] = await connection.query(
            "SELECT id FROM year_levels WHERE id = ? LIMIT 1",
            [yearLevelId]
          );
          if (yearLevelResult.length === 0) continue;

          const [insertBlockResult] = await connection.query(
            `INSERT INTO blocks (name, department_id, course_id, year_level_id, school_year_semester_id, status)
             VALUES (?, ?, ?, ?, ?, 'Active')`,
            [blockName, departmentId, courseId, yearLevelId, newSemesterId]
          );
          blockId = insertBlockResult.insertId;
        }
        blockCache.set(blockKey, blockId);
      }

      const idNumber = row.id_number.trim();
      const firstName = (row.first_name || "").trim();
      const middleName = (row.middle_name || "").trim();
      const lastName = (row.last_name || "").trim();
      const suffix = (row.suffix || "").trim();

      const [userResult] = await connection.query(
        "SELECT id_number, status FROM users WHERE id_number = ? LIMIT 1",
        [idNumber]
      );

      if (userResult.length === 0) {
        await connection.query(
          `INSERT INTO users (id_number, first_name, middle_name, last_name, suffix, block_id, status)
           VALUES (?, ?, ?, ?, ?, ?, 'Unregistered')`,
          [idNumber, firstName, middleName, lastName, suffix, blockId]
        );
      } else {
        const userStatus = userResult[0].status;
        const updateQuery = `
          UPDATE users
          SET first_name = ?,
          middle_name = ?,
          last_name = ?,
          suffix = ?,
          block_id = ?
          WHERE id_number = ?
        `;
        const updateValues = [
          firstName,
          middleName,
          lastName,
          suffix,
          blockId,
          idNumber,
        ];
        await connection.query(updateQuery, updateValues);

        if (userStatus !== "Unregistered") {
          await connection.query(
            `UPDATE users SET status = 'Active' WHERE id_number = ?`,
            [idNumber]
          );
        }
      }
    }

    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function populateAttendanceForCurrentSemester(
  connection,
  currentSemesterId
) {
  const [eventsResult] = await connection.query(
    `
    SELECT e.id as event_id 
    FROM events e 
    WHERE e.school_year_semester_id = ? 
    AND e.status = 'Approved'
  `,
    [currentSemesterId]
  );

  if (eventsResult.length === 0) {
    return;
  }

  let totalAttendanceRecordsCreated = 0;

  for (const event of eventsResult) {
    const eventId = event.event_id;

    const [eventDatesResult] = await connection.query(
      `
      SELECT id as event_date_id 
      FROM event_dates 
      WHERE event_id = ?
    `,
      [eventId]
    );

    if (eventDatesResult.length === 0) {
      continue;
    }

    const [studentsResult] = await connection.query(
      `
      SELECT DISTINCT u.id_number, u.block_id
      FROM users u
      JOIN blocks b ON u.block_id = b.id
      WHERE b.school_year_semester_id = ?
      AND u.status = 'Active'
      AND u.role_id = (SELECT id FROM roles WHERE name = 'Student' LIMIT 1)
    `,
      [currentSemesterId]
    );

    if (studentsResult.length === 0) {
      continue;
    }

    for (const student of studentsResult) {
      const studentIdNumber = student.id_number;
      const studentBlockId = student.block_id;

      const [eventBlockConnection] = await connection.query(
        `
        SELECT COUNT(*) as is_connected
        FROM event_blocks eb
        WHERE eb.event_id = ? AND eb.block_id = ?
      `,
        [eventId, studentBlockId]
      );

      const isConnected = eventBlockConnection[0].is_connected > 0;

      if (isConnected) {
        for (const eventDate of eventDatesResult) {
          const eventDateId = eventDate.event_date_id;

          const [existingAttendanceResult] = await connection.query(
            `
            SELECT id 
            FROM attendance 
            WHERE event_date_id = ? AND student_id_number = ?
            LIMIT 1
          `,
            [eventDateId, studentIdNumber]
          );

          if (existingAttendanceResult.length === 0) {
            await connection.query(
              `
              INSERT INTO attendance (event_date_id, student_id_number, block_id, am_in, am_out, pm_in, pm_out)
              VALUES (?, ?, ?, FALSE, FALSE, FALSE, FALSE)
            `,
              [eventDateId, studentIdNumber, studentBlockId]
            );

            totalAttendanceRecordsCreated++;
          }
        }
      }
    }
  }
}

async function getCurrentSchoolYear(req, res) {
  const connection = await pool.getConnection();

  try {
    const query = `
      SELECT 
        id,
        school_year,
        semester,
        status
      FROM school_year_semesters 
      WHERE status = 'Active'
      ORDER BY id DESC
      LIMIT 1
    `;

    const [result] = await connection.query(query);

    if (result.length === 0) {
      console.warn("[getCurrentSchoolYear] No active school year found");
      return res.status(404).json({
        success: false,
        message: "No active school year found",
      });
    }

    const currentSchoolYear = result[0];

    return res.status(200).json({
      success: true,
      message: "Current school year retrieved successfully",
      data: {
        id: currentSchoolYear.id,
        school_year: currentSchoolYear.school_year,
        semester: currentSchoolYear.semester,
        status: currentSchoolYear.status,
      },
    });
  } catch (error) {
    console.error(
      "[getCurrentSchoolYear] Error fetching current school year:",
      error.message
    );
    return res.status(500).json({
      success: false,
      message: "Failed to fetch current school year",
      error: error.message,
    });
  } finally {
    connection.release();
  }
}

module.exports = {
  updateStudents,
  changeSchoolYear,
  getCurrentSchoolYear,
};
