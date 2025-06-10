const { pool } = require("../config/db");
const config = require("../config/config");
const moment = require("moment");

exports.syncAttendance = async (req, res) => {
  try {
    const { attendanceData } = req.body;

    if (!Array.isArray(attendanceData)) {
      return res.status(400).json({
        message: "Invalid attendance data format. Expected an array.",
      });
    }

    const connection = await pool.getConnection();

    try {
      const syncedRecords = [];
      const failedRecords = [];

      for (const record of attendanceData) {
        const {
          event_date_id,
          student_id_number,
          am_in,
          am_out,
          pm_in,
          pm_out,
        } = record;

        if (!event_date_id || !student_id_number) {
          failedRecords.push({
            record,
            error:
              "Missing required fields: event_date_id and/or student_id_number.",
          });
          continue;
        }

        const numericEventDateId = parseInt(event_date_id);
        const numericStudentId = student_id_number;

        if (isNaN(numericEventDateId)) {
          failedRecords.push({
            record,
            error: "Invalid event_date_id.",
          });
          continue;
        }

        const [userResult] = await connection.query(
          `SELECT block_id FROM users WHERE id_number = ? AND status = 'Active'`,
          [numericStudentId]
        );

        if (userResult.length === 0) {
          failedRecords.push({
            record,
            error: "Student not found or not active.",
          });
          continue;
        }

        const studentBlockId = userResult[0].block_id;

        const [eventDateResult] = await connection.query(
          `SELECT id FROM event_dates WHERE id = ?`,
          [numericEventDateId]
        );

        if (eventDateResult.length === 0) {
          failedRecords.push({
            record,
            error: "Event date not found.",
          });
          continue;
        }

        const selectQuery = `
          SELECT id FROM attendance
          WHERE event_date_id = ? AND student_id_number = ?
        `;
        const [rows] = await connection.query(selectQuery, [
          numericEventDateId,
          numericStudentId,
        ]);

        if (rows.length > 0) {
          let updateFields = [];
          let updateValues = [];

          if (am_in !== undefined) {
            updateFields.push("am_in = ?");
            updateValues.push(Boolean(am_in));
          }
          if (am_out !== undefined) {
            updateFields.push("am_out = ?");
            updateValues.push(Boolean(am_out));
          }
          if (pm_in !== undefined) {
            updateFields.push("pm_in = ?");
            updateValues.push(Boolean(pm_in));
          }
          if (pm_out !== undefined) {
            updateFields.push("pm_out = ?");
            updateValues.push(Boolean(pm_out));
          }

          updateFields.push("block_id = ?");
          updateValues.push(studentBlockId);

          if (updateFields.length > 0) {
            const updateQuery = `
              UPDATE attendance
              SET ${updateFields.join(", ")}
              WHERE event_date_id = ? AND student_id_number = ?
            `;
            updateValues.push(numericEventDateId, numericStudentId);

            await connection.query(updateQuery, updateValues);
          }

          syncedRecords.push({
            id: rows[0].id,
            event_date_id: numericEventDateId,
            student_id_number: numericStudentId,
            block_id: studentBlockId,
            action: "updated",
          });
        } else {
          const insertQuery = `
            INSERT INTO attendance (event_date_id, student_id_number, block_id, am_in, am_out, pm_in, pm_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `;
          const [result] = await connection.query(insertQuery, [
            numericEventDateId,
            numericStudentId,
            studentBlockId,
            Boolean(am_in || false),
            Boolean(am_out || false),
            Boolean(pm_in || false),
            Boolean(pm_out || false),
          ]);

          syncedRecords.push({
            id: result.insertId,
            event_date_id: numericEventDateId,
            student_id_number: numericStudentId,
            block_id: studentBlockId,
            action: "inserted",
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: "Attendance sync completed.",
        data: {
          synced_count: syncedRecords.length,
          failed_count: failedRecords.length,
          synced_records: syncedRecords,
          failed_records: failedRecords,
        },
      });
    } catch (dbError) {
      console.error("Database error:", dbError);
      return res.status(500).json({
        success: false,
        message: "Database error while syncing attendance.",
        error: dbError.message,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("An error occurred:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing the data.",
      error: error.message,
    });
  }
};

exports.fetchUserOngoingEvents = async (req, res) => {
  try {
    const { id_number, page = 1, limit = 10, search = "" } = req.body;

    if (!id_number) {
      return res.status(400).json({
        message: "Missing required parameter: id_number.",
      });
    }

    const connection = await pool.getConnection();

    try {
      const today = moment().format("YYYY-MM-DD");

      const userQuery = `
        SELECT block_id 
        FROM users 
        WHERE id_number = ?
      `;
      const [userRows] = await connection.query(userQuery, [id_number]);

      if (userRows.length === 0) {
        return res.status(404).json({
          message: "User not found.",
        });
      }

      const block_id = userRows[0].block_id;

      const offset = (page - 1) * limit;

      let baseQuery = `
        SELECT 
          event_id,
          event_name,
          event_dates,
          event_date_ids
        FROM 
          view_events
        WHERE 
          FIND_IN_SET(?, block_ids) > 0
          AND status = 'Approved'
      `;

      if (search.trim() !== "") {
        baseQuery += ` AND event_name LIKE ?`;
      }

      baseQuery += ` ORDER BY STR_TO_DATE(SUBSTRING_INDEX(event_dates, ',', 1), '%Y-%m-%d') ASC`;

      const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;

      const queryParams = [block_id];
      if (search.trim() !== "") {
        queryParams.push(`%${search}%`);
      }
      queryParams.push(limit, offset);

      const [rows] = await connection.query(paginatedQuery, queryParams);

      const parseEventDates = (eventDatesString) => {
        if (!eventDatesString) return [];

        const dates = eventDatesString
          .split(",")
          .map((date) => date.trim())
          .filter(Boolean);
        return dates
          .map((dateStr) => {
            const parsed = moment(
              dateStr,
              ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"],
              true
            );
            return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
          })
          .filter(Boolean);
      };

      const filteredRows = rows.filter((row) => {
        const eventDates = parseEventDates(row.event_dates);

        if (eventDates.length === 0) return false;

        const sortedDates = eventDates.sort();
        const firstDate = sortedDates[0];
        const lastDate = sortedDates[sortedDates.length - 1];

        return moment(today).isBetween(
          moment(firstDate),
          moment(lastDate),
          "day",
          "[]"
        );
      });

      const formattedRows = await Promise.all(
        filteredRows.map(async (row) => {
          const eventDates = parseEventDates(row.event_dates);
          const eventDateIds = row.event_date_ids
            ? row.event_date_ids
                .split(",")
                .map((id) => parseInt(id.trim()))
                .filter((id) => !isNaN(id))
            : [];

          let attendanceMap = {};

          if (eventDateIds.length > 0) {
            const attendanceQuery = `
              SELECT 
                event_date_id,
                am_in,
                am_out,
                pm_in,
                pm_out
              FROM 
                attendance
              WHERE 
                student_id_number = ? AND event_date_id IN (${eventDateIds
                  .map(() => "?")
                  .join(",")})
            `;

            const attendanceParams = [id_number, ...eventDateIds];
            const [attendanceRows] = await connection.query(
              attendanceQuery,
              attendanceParams
            );

            attendanceRows.forEach((record) => {
              const dateIndex = eventDateIds.indexOf(record.event_date_id);
              if (dateIndex >= 0 && dateIndex < eventDates.length) {
                const date = eventDates[dateIndex];
                attendanceMap[date] = {
                  am_in: Boolean(record.am_in),
                  am_out: Boolean(record.am_out),
                  pm_in: Boolean(record.pm_in),
                  pm_out: Boolean(record.pm_out),
                };
              }
            });
          }

          eventDates.forEach((date) => {
            if (!attendanceMap[date]) {
              attendanceMap[date] = {
                am_in: false,
                am_out: false,
                pm_in: false,
                pm_out: false,
              };
            }
          });

          return {
            event_id: row.event_id,
            event_name: row.event_name,
            event_dates: eventDates,
            attendance: attendanceMap,
          };
        })
      );

      let countQuery = `
        SELECT COUNT(*) AS total
        FROM view_events
        WHERE FIND_IN_SET(?, block_ids) > 0
          AND status = 'Approved'
      `;

      if (search.trim() !== "") {
        countQuery += ` AND event_name LIKE ?`;
      }

      const countParams = [block_id];
      if (search.trim() !== "") {
        countParams.push(`%${search}%`);
      }

      const [countRows] = await connection.query(countQuery, countParams);

      const totalRecords = rows.filter((row) => {
        const eventDates = parseEventDates(row.event_dates);
        if (eventDates.length === 0) return false;

        const sortedDates = eventDates.sort();
        const firstDate = sortedDates[0];
        const lastDate = sortedDates[sortedDates.length - 1];

        return moment(today).isBetween(
          moment(firstDate),
          moment(lastDate),
          "day",
          "[]"
        );
      }).length;

      return res.status(200).json({
        success: true,
        message: "Events fetched successfully.",
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalRecords,
          totalPages: Math.ceil(totalRecords / limit),
        },
        events: formattedRows,
      });
    } catch (dbError) {
      console.error("Database error:", dbError);
      return res.status(500).json({
        message: "Database error while fetching user events.",
        error:
          process.env.NODE_ENV === "development" ? dbError.message : undefined,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({
      message: "An error occurred while processing the request.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

exports.fetchUserPastEvents = async (req, res) => {
  try {
    const { id_number, page = 1, limit = 10, search = "" } = req.body;

    if (!id_number) {
      return res.status(400).json({
        message: "Missing required parameter: id_number.",
      });
    }

    const connection = await pool.getConnection();

    try {
      const userQuery = `
        SELECT block_id 
        FROM users 
        WHERE id_number = ?
      `;
      const [userRows] = await connection.query(userQuery, [id_number]);

      if (userRows.length === 0) {
        return res.status(404).json({
          message: "User not found.",
        });
      }

      const block_id = userRows[0].block_id;
      const offset = (page - 1) * limit;

      const parseEventDates = (eventDatesString) => {
        if (!eventDatesString) return [];

        const dates = eventDatesString
          .split(",")
          .map((date) => date.trim())
          .filter(Boolean);
        return dates
          .map((dateStr) => {
            const parsed = moment(
              dateStr,
              ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"],
              true
            );
            return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
          })
          .filter(Boolean);
      };

      let baseQuery = `
        SELECT 
          event_id,
          event_name,
          event_dates,
          event_date_ids
        FROM 
          view_events
        WHERE 
          FIND_IN_SET(?, block_ids) > 0
          AND status = 'Archived'
      `;

      if (search.trim() !== "") {
        baseQuery += ` AND event_name LIKE ?`;
      }

      baseQuery += ` ORDER BY STR_TO_DATE(SUBSTRING_INDEX(event_dates, ',', -1), '%Y-%m-%d') DESC`;

      const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;

      const queryParams = [block_id];
      if (search.trim() !== "") {
        queryParams.push(`%${search}%`);
      }
      queryParams.push(limit, offset);

      const [rows] = await connection.query(paginatedQuery, queryParams);

      const formattedRows = await Promise.all(
        rows.map(async (row) => {
          const eventDates = parseEventDates(row.event_dates);
          const eventDateIds = row.event_date_ids
            ? row.event_date_ids
                .split(",")
                .map((id) => parseInt(id.trim()))
                .filter((id) => !isNaN(id))
            : [];

          let attendanceMap = {};

          if (eventDateIds.length > 0) {
            const attendanceQuery = `
              SELECT 
                event_date_id,
                am_in,
                am_out,
                pm_in,
                pm_out
              FROM 
                attendance
              WHERE 
                student_id_number = ? AND event_date_id IN (${eventDateIds
                  .map(() => "?")
                  .join(",")})
            `;

            const attendanceParams = [id_number, ...eventDateIds];
            const [attendanceRows] = await connection.query(
              attendanceQuery,
              attendanceParams
            );

            attendanceRows.forEach((record) => {
              const dateIndex = eventDateIds.indexOf(record.event_date_id);
              if (dateIndex >= 0 && dateIndex < eventDates.length) {
                const date = eventDates[dateIndex];
                attendanceMap[date] = {
                  am_in: Boolean(record.am_in),
                  am_out: Boolean(record.am_out),
                  pm_in: Boolean(record.pm_in),
                  pm_out: Boolean(record.pm_out),
                };
              }
            });
          }

          eventDates.forEach((date) => {
            if (!attendanceMap[date]) {
              attendanceMap[date] = {
                am_in: false,
                am_out: false,
                pm_in: false,
                pm_out: false,
              };
            }
          });

          return {
            event_id: row.event_id,
            event_name: row.event_name,
            event_dates: eventDates,
            attendance: attendanceMap,
          };
        })
      );

      let countQuery = `
        SELECT COUNT(*) AS total
        FROM view_events
        WHERE FIND_IN_SET(?, block_ids) > 0
          AND status = 'Archived'
      `;

      const countParams = [block_id];
      if (search.trim() !== "") {
        countQuery += ` AND event_name LIKE ?`;
        countParams.push(`%${search}%`);
      }

      const [countRows] = await connection.query(countQuery, countParams);
      const totalRecords = countRows[0].total;

      return res.status(200).json({
        success: true,
        message: "Past events fetched successfully.",
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalRecords,
          totalPages: Math.ceil(totalRecords / limit),
        },
        events: formattedRows,
      });
    } catch (dbError) {
      console.error("Database error:", dbError);
      return res.status(500).json({
        message: "Database error while fetching past events.",
        error:
          process.env.NODE_ENV === "development" ? dbError.message : undefined,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({
      message: "An error occurred while processing the request.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

exports.fetchAllPastEvents = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.body;

    const connection = await pool.getConnection();

    try {
      const offset = (page - 1) * limit;

      const baseQuery = `
        SELECT 
          event_id,
          event_name,
          event_dates
        FROM 
          view_events
        WHERE 
          status = 'Archived'
        ORDER BY 
          SUBSTRING_INDEX(event_dates, ',', 1) ASC
      `;

      const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;
      const [rows] = await connection.query(paginatedQuery, [limit, offset]);

      const countQuery = `
        SELECT COUNT(*) AS total
        FROM view_events
        WHERE status = 'Archived'
      `;
      const [countRows] = await connection.query(countQuery);
      const totalRecords = countRows[0].total;

      return res.status(200).json({
        success: true,
        message: "All past events fetched successfully.",
        pagination: {
          page,
          limit,
          totalRecords,
          totalPages: Math.ceil(totalRecords / limit),
        },
        events: rows,
      });
    } catch (dbError) {
      return res.status(500).json({
        message: "Database error while fetching all past events.",
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    return res.status(500).json({
      message: "An error occurred while processing the request.",
    });
  }
};

exports.fetchAllOngoingEvents = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "" } = req.body;

    const connection = await pool.getConnection();

    try {
      const offset = (page - 1) * limit;

      let baseQuery = `
        SELECT 
          event_id,
          event_name,
          event_dates
        FROM 
          view_events
        WHERE 
          status = 'Approved'
      `;

      if (search.trim() !== "") {
        baseQuery += ` AND event_name LIKE ?`;
      }

      baseQuery += ` ORDER BY SUBSTRING_INDEX(event_dates, ',', 1) ASC`;

      const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;

      const queryParams = [];
      if (search.trim() !== "") {
        queryParams.push(`%${search}%`);
      }
      queryParams.push(limit, offset);

      const [rows] = await connection.query(paginatedQuery, queryParams);

      let countQuery = `
        SELECT COUNT(*) AS total
        FROM view_events
        WHERE status = 'Approved'
      `;

      if (search.trim() !== "") {
        countQuery += ` AND event_name LIKE ?`;
      }

      const countParams = [];
      if (search.trim() !== "") {
        countParams.push(`%${search}%`);
      }

      const [countRows] = await connection.query(countQuery, countParams);
      const totalRecords = countRows[0].total;

      return res.status(200).json({
        success: true,
        message: "All ongoing events fetched successfully.",
        pagination: {
          page,
          limit,
          totalRecords,
          totalPages: Math.ceil(totalRecords / limit),
        },
        events: rows,
      });
    } catch (dbError) {
      return res.status(500).json({
        message: "Database error while fetching all ongoing events.",
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    return res.status(500).json({
      message: "An error occurred while processing the request.",
    });
  }
};

exports.fetchBlocksOfEvents = async (req, res) => {
  try {
    const { event_id, department_id, year_level_id, search_query } = req.body;

    if (!event_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameter: event_id.",
      });
    }

    const connection = await pool.getConnection();
    try {
      let query = `
        SELECT 
          eb.event_id,
          e.event_name_id,
          en.name AS event_title,
          current_b.id AS block_id,
          current_b.name AS block_name,
          current_c.id AS course_id,
          current_c.code AS course_code,
          current_b.department_id,
          current_b.year_level_id,
          current_b.status AS block_status,
          u.id_number AS student_id,
          CONCAT(u.last_name, ', ', u.first_name, IFNULL(CONCAT(' ', u.middle_name), '')) AS student_name,
          att.am_in, 
          att.am_out, 
          att.pm_in, 
          att.pm_out
        FROM event_blocks eb
        JOIN blocks original_b ON eb.block_id = original_b.id
        JOIN events e ON eb.event_id = e.id
        JOIN event_names en ON e.event_name_id = en.id
        
        -- Find current active blocks that match the same department, course, year_level, and name as original blocks
        JOIN blocks current_b ON (
          current_b.department_id = original_b.department_id 
          AND current_b.year_level_id = original_b.year_level_id
          AND current_b.name = original_b.name
          AND current_b.status = 'Active'
        )
        JOIN courses current_c ON current_b.course_id = current_c.id
        
        -- Get students from current active blocks
        LEFT JOIN users u ON u.block_id = current_b.id AND u.status = 'Active'
        
        -- Get attendance records (could be from original block_id or current block_id)
        LEFT JOIN attendance att ON att.student_id_number = u.id_number
        LEFT JOIN event_dates ed ON ed.id = att.event_date_id AND ed.event_id = eb.event_id
        
        WHERE e.status IN ('Approved', 'Archived')
          AND eb.event_id = ?
      `;

      const params = [event_id];

      if (department_id) {
        query += ` AND current_b.department_id = ?`;
        params.push(department_id);
      }

      if (year_level_id) {
        query += ` AND current_b.year_level_id = ?`;
        params.push(year_level_id);
      }

      if (
        search_query &&
        typeof search_query === "string" &&
        search_query.trim() !== ""
      ) {
        const likeQuery = `%${search_query.trim()}%`;
        query += ` AND (current_b.name LIKE ? OR current_c.code LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)`;
        params.push(likeQuery, likeQuery, likeQuery, likeQuery);
      }

      const [rows] = await connection.query(query, params);

      if (rows.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No matching data found or no blocks with active students.",
          data: {
            event_id: Number(event_id),
            event_title: "Event Blocks",
            blocks: [],
          },
        });
      }

      const event_title = rows[0].event_title;

      const blockMap = {};

      for (const row of rows) {
        if (!blockMap[row.block_id]) {
          blockMap[row.block_id] = {
            block_id: row.block_id,
            block_name: row.block_name,
            course_code: row.course_code,
            department_id: row.department_id,
            year_level_id: row.year_level_id,
            status: row.block_status,
            students: [],
          };
        }

        if (row.student_id) {
          blockMap[row.block_id].students.push({
            student_id: row.student_id,
            student_name: row.student_name,
            am_in: row.am_in,
            am_out: row.am_out,
            pm_in: row.pm_in,
            pm_out: row.pm_out,
          });
        }
      }

      const blocks = Object.values(blockMap).filter(
        (block) => block.students.length > 0
      );

      if (blocks.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No blocks found with active students.",
          data: {
            event_id: Number(event_id),
            event_title,
            blocks: [],
          },
        });
      }

      return res.status(200).json({
        success: true,
        message: "Event block data retrieved successfully.",
        data: {
          event_id: Number(event_id),
          event_title,
          blocks,
        },
      });
    } catch (dbError) {
      return res.status(500).json({
        success: false,
        message: "Database error while fetching event block details.",
        error: dbError.message,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing the request.",
      error: error.message,
    });
  }
};

exports.fetchStudentAttendanceByEventAndBlock = async (req, res) => {
  try {
    const { event_id, block_id, search_query, page = 1, limit = 10 } = req.body;

    if (!event_id || !block_id) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: event_id and block_id are required.",
      });
    }

    const connection = await pool.getConnection();
    try {
      const [eventBlockCheck] = await connection.query(
        `SELECT * FROM event_blocks WHERE event_id = ? AND block_id = ?`,
        [event_id, block_id]
      );

      const [studentsInBlock] = await connection.query(
        `SELECT COUNT(*) AS count FROM users WHERE block_id = ? AND status = 'Active'`,
        [block_id]
      );

      if (studentsInBlock[0].count === 0) {
        const [eventDetails] = await connection.query(
          `SELECT en.name AS event_name
           FROM events e
           JOIN event_names en ON e.event_name_id = en.id
           WHERE e.id = ?`,
          [event_id]
        );

        const [blockDetails] = await connection.query(
          `SELECT b.name AS block_name
           FROM blocks b
           WHERE b.id = ?`,
          [block_id]
        );

        return res.status(200).json({
          success: true,
          message: "No active students found for the specified block.",
          data: {
            event_id: Number(event_id),
            event_name:
              eventDetails.length > 0
                ? eventDetails[0].event_name
                : "Unknown Event",
            block_id: Number(block_id),
            block_name:
              blockDetails.length > 0
                ? blockDetails[0].block_name
                : "Unknown Block",
            students: [],
            pagination: {
              total: 0,
              page: 1,
              limit: Number(limit),
              total_pages: 0,
            },
          },
        });
      }

      let query = `
        SELECT 
          u.id_number AS student_id,
          u.first_name,
          u.middle_name,
          u.last_name,
          u.suffix,
          u.email,
          u.status AS user_status,
          b.id AS block_id,
          b.name AS block_name,
          c.code AS course_code,
          d.name AS department_name,
          d.code AS department_code,
          y.name AS year_level,
          ed.event_date,
          ed.am_in AS event_am_in,
          ed.am_out AS event_am_out,
          ed.pm_in AS event_pm_in,
          ed.pm_out AS event_pm_out,
          a.am_in AS student_am_in,
          a.am_out AS student_am_out,
          a.pm_in AS student_pm_in,
          a.pm_out AS student_pm_out
        FROM users u
        JOIN blocks b ON u.block_id = b.id
        JOIN courses c ON b.course_id = c.id
        JOIN departments d ON b.department_id = d.id
        JOIN year_levels y ON b.year_level_id = y.id
        JOIN event_dates ed ON ed.event_id = ?
        LEFT JOIN attendance a ON a.student_id_number = u.id_number AND a.event_date_id = ed.id
        WHERE b.id = ? AND u.status = 'Active'
      `;

      const params = [event_id, block_id];

      if (
        search_query &&
        typeof search_query === "string" &&
        search_query.trim() !== ""
      ) {
        const likeQuery = `%${search_query.trim()}%`;
        query += ` AND (
          u.id_number LIKE ? OR 
          u.first_name LIKE ? OR 
          u.last_name LIKE ? OR
          CONCAT(u.first_name, ' ', u.last_name) LIKE ? OR
          CONCAT(u.last_name, ', ', u.first_name) LIKE ?
        )`;
        params.push(likeQuery, likeQuery, likeQuery, likeQuery, likeQuery);
      }

      query += ` ORDER BY ed.event_date, u.last_name, u.first_name`;

      const [rows] = await connection.query(query, params);

      const [eventDetails] = await connection.query(
        `SELECT en.name AS event_name, e.venue, e.description, e.status AS event_status
         FROM events e
         JOIN event_names en ON e.event_name_id = en.id
         WHERE e.id = ?`,
        [event_id]
      );

      const studentMap = {};

      const formatDateToYYYYMMDD = (dateObj) => {
        if (!dateObj) return "unknown";

        const date = new Date(dateObj);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");

        return `${year}-${month}-${day}`;
      };

      rows.forEach((row) => {
        const studentKey = row.student_id;

        if (!studentMap[studentKey]) {
          studentMap[studentKey] = {
            student_id: row.student_id,
            name: `${row.last_name}, ${row.first_name}${
              row.middle_name ? " " + row.middle_name.charAt(0) + "." : ""
            }${row.suffix ? " " + row.suffix : ""}`,
            first_name: row.first_name,
            middle_name: row.middle_name,
            last_name: row.last_name,
            suffix: row.suffix,
            email: row.email,
            status: row.user_status,
            dates: [],
          };
        }

        studentMap[studentKey].dates.push({
          date: formatDateToYYYYMMDD(row.event_date),
          schedule: {
            ...(row.event_am_in && { am_in: row.event_am_in }),
            ...(row.event_am_out && { am_out: row.event_am_out }),
            ...(row.event_pm_in && { pm_in: row.event_pm_in }),
            ...(row.event_pm_out && { pm_out: row.event_pm_out }),
          },
          attendance: {
            ...(row.student_am_in && { am_in: row.student_am_in }),
            ...(row.student_am_out && { am_out: row.student_am_out }),
            ...(row.student_pm_in && { pm_in: row.student_pm_in }),
            ...(row.student_pm_out && { pm_out: row.student_pm_out }),
          },
        });
      });

      const students = Object.values(studentMap);

      const total = students.length;
      const pageInt = parseInt(page);
      const limitInt = parseInt(limit);
      const startIndex = (pageInt - 1) * limitInt;
      const endIndex = startIndex + limitInt;
      const paginatedStudents = students.slice(startIndex, endIndex);

      const result = {
        success: true,
        message:
          eventBlockCheck.length === 0
            ? "Block was not found in event_blocks, but attendance records still exist."
            : "Student attendance data retrieved successfully.",
        data: {
          event_id: Number(event_id),
          event_name:
            eventDetails.length > 0
              ? eventDetails[0].event_name
              : "Unknown Event",
          event_details:
            eventDetails.length > 0
              ? {
                  venue: eventDetails[0].venue,
                  description: eventDetails[0].description,
                  status: eventDetails[0].event_status,
                }
              : null,
          block_id: Number(block_id),
          block_name: rows.length > 0 ? rows[0].block_name : "Unknown Block",
          course_code: rows.length > 0 ? rows[0].course_code : null,
          department:
            rows.length > 0
              ? {
                  name: rows[0].department_name,
                  code: rows[0].department_code,
                }
              : null,
          year_level: rows.length > 0 ? rows[0].year_level : null,
          students: paginatedStudents,
          pagination: {
            total,
            page: pageInt,
            limit: limitInt,
            total_pages: Math.ceil(total / limitInt),
          },
        },
      };

      return res.status(200).json(result);
    } finally {
      connection.release();
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing the request.",
      error: error.message,
    });
  }
};

exports.fetchAttendanceSummaryPerBlock = async (req, res) => {
  try {
    const {
      event_id,
      block_id,
      attendanceFilter = "all",
      attendance_filter,
    } = req.body;
    const finalAttendanceFilter =
      attendanceFilter || attendance_filter || "all";
    if (!event_id || !block_id) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: event_id and block_id are required.",
      });
    }
    const connection = await pool.getConnection();
    try {
      const dateQuery = `
        SELECT 
          MIN(event_date) AS first_date,
          MAX(event_date) AS last_date
        FROM event_dates
        WHERE event_id = ?;
      `;
      const [dateRows] = await connection.query(dateQuery, [event_id]);
      const firstDate = dateRows[0].first_date
        ? dateRows[0].first_date.toISOString().split("T")[0]
        : null;
      const lastDate = dateRows[0].last_date
        ? dateRows[0].last_date.toISOString().split("T")[0]
        : null;

      const timePeriodQuery = `
        SELECT 
          COUNT(CASE WHEN am_in IS NOT NULL THEN 1 END) AS has_am_in,
          COUNT(CASE WHEN am_out IS NOT NULL THEN 1 END) AS has_am_out,
          COUNT(CASE WHEN pm_in IS NOT NULL THEN 1 END) AS has_pm_in,
          COUNT(CASE WHEN pm_out IS NOT NULL THEN 1 END) AS has_pm_out
        FROM event_dates
        WHERE event_id = ?;
      `;
      const [timePeriodRows] = await connection.query(timePeriodQuery, [
        event_id,
      ]);
      const availableTimePeriods = {
        hasAmIn: timePeriodRows[0].has_am_in > 0,
        hasAmOut: timePeriodRows[0].has_am_out > 0,
        hasPmIn: timePeriodRows[0].has_pm_in > 0,
        hasPmOut: timePeriodRows[0].has_pm_out > 0,
      };

      const query = `
        SELECT 
          u.id_number AS student_id,
          CONCAT(u.last_name, ', ', u.first_name, IFNULL(CONCAT(' ', u.suffix), '')) AS student_name,
          ed.id AS date_id,
          ed.event_date,
          ed.am_in AS date_am_in,
          ed.am_out AS date_am_out,
          ed.pm_in AS date_pm_in,
          ed.pm_out AS date_pm_out,
          a.am_in AS att_am_in,
          a.am_out AS att_am_out,
          a.pm_in AS att_pm_in,
          a.pm_out AS att_pm_out
        FROM users u
        JOIN blocks b ON u.block_id = b.id
        JOIN event_blocks eb ON eb.block_id = b.id AND eb.event_id = ?
        JOIN event_dates ed ON ed.event_id = eb.event_id
        LEFT JOIN attendance a ON a.student_id_number = u.id_number AND a.event_date_id = ed.id
        WHERE b.id = ? AND u.status = 'Active'
        ORDER BY u.id_number, ed.event_date;
      `;
      const [rows] = await connection.query(query, [event_id, block_id]);

      if (rows.length === 0) {
        return res.status(200).json({
          success: true,
          message:
            "No attendance records found for active students in this block.",
          data: {
            event_id: Number(event_id),
            block_id: Number(block_id),
            first_event_date: firstDate,
            last_event_date: lastDate,
            available_time_periods: availableTimePeriods,
            attendance_summary: [],
          },
        });
      }

      const studentMap = new Map();
      rows.forEach((row) => {
        const key = row.student_id;
        if (!studentMap.has(key)) {
          const studentData = {
            student_id: row.student_id,
            student_name: row.student_name,
            present_count: 0,
            absent_count: 0,
            total_sessions: 0,
            attendance_details: [],
          };

          if (availableTimePeriods.hasAmIn) {
            studentData.am_in_attended = 0;
            studentData.am_in_total = 0;
          }
          if (availableTimePeriods.hasAmOut) {
            studentData.am_out_attended = 0;
            studentData.am_out_total = 0;
          }
          if (availableTimePeriods.hasPmIn) {
            studentData.pm_in_attended = 0;
            studentData.pm_in_total = 0;
          }
          if (availableTimePeriods.hasPmOut) {
            studentData.pm_out_attended = 0;
            studentData.pm_out_total = 0;
          }

          studentMap.set(key, studentData);
        }

        const student = studentMap.get(key);
        const {
          date_id,
          event_date,
          date_am_in,
          date_am_out,
          date_pm_in,
          date_pm_out,
          att_am_in,
          att_am_out,
          att_pm_in,
          att_pm_out,
        } = row;

        let sessionsRequired = 0;
        let sessionsAttended = 0;

        if (
          availableTimePeriods.hasAmIn &&
          date_am_in !== null &&
          date_am_in !== undefined
        ) {
          sessionsRequired += 1;
          student.am_in_total += 1;
          if (att_am_in === 1) {
            sessionsAttended += 1;
            student.am_in_attended += 1;
          }
        }

        if (
          availableTimePeriods.hasAmOut &&
          date_am_out !== null &&
          date_am_out !== undefined
        ) {
          sessionsRequired += 1;
          student.am_out_total += 1;
          if (att_am_out === 1) {
            sessionsAttended += 1;
            student.am_out_attended += 1;
          }
        }

        if (
          availableTimePeriods.hasPmIn &&
          date_pm_in !== null &&
          date_pm_in !== undefined
        ) {
          sessionsRequired += 1;
          student.pm_in_total += 1;
          if (att_pm_in === 1) {
            sessionsAttended += 1;
            student.pm_in_attended += 1;
          }
        }

        if (
          availableTimePeriods.hasPmOut &&
          date_pm_out !== null &&
          date_pm_out !== undefined
        ) {
          sessionsRequired += 1;
          student.pm_out_total += 1;
          if (att_pm_out === 1) {
            sessionsAttended += 1;
            student.pm_out_attended += 1;
          }
        }

        student.present_count += sessionsAttended;
        student.absent_count += sessionsRequired - sessionsAttended;
        student.total_sessions += sessionsRequired;

        const attendanceDetail = {
          date_id: date_id,
          event_date: event_date
            ? event_date.toISOString().split("T")[0]
            : null,
          sessions_required: sessionsRequired,
          sessions_attended: sessionsAttended,
        };

        if (availableTimePeriods.hasAmIn) {
          attendanceDetail.am_in =
            att_am_in === 1
              ? `${event_date.toISOString().split("T")[0]}T${date_am_in}`
              : null;
          attendanceDetail.am_in_attended = att_am_in === 1;
        }

        if (availableTimePeriods.hasAmOut) {
          attendanceDetail.am_out =
            att_am_out === 1
              ? `${event_date.toISOString().split("T")[0]}T${date_am_out}`
              : null;
          attendanceDetail.am_out_attended = att_am_out === 1;
        }

        if (availableTimePeriods.hasPmIn) {
          attendanceDetail.pm_in =
            att_pm_in === 1
              ? `${event_date.toISOString().split("T")[0]}T${date_pm_in}`
              : null;
          attendanceDetail.pm_in_attended = att_pm_in === 1;
        }

        if (availableTimePeriods.hasPmOut) {
          attendanceDetail.pm_out =
            att_pm_out === 1
              ? `${event_date.toISOString().split("T")[0]}T${date_pm_out}`
              : null;
          attendanceDetail.pm_out_attended = att_pm_out === 1;
        }

        student.attendance_details.push(attendanceDetail);
      });

      let attendanceSummary = Array.from(studentMap.values()).map((student) => {
        const summary = {
          student_id: student.student_id,
          student_name: student.student_name,
          present_count: student.present_count,
          absent_count: student.absent_count,
          total_sessions: student.total_sessions,
          attendance_details: student.attendance_details,
        };

        if (availableTimePeriods.hasAmIn) {
          summary.am_in_attended = student.am_in_attended;
          summary.am_in_total = student.am_in_total;
        }
        if (availableTimePeriods.hasAmOut) {
          summary.am_out_attended = student.am_out_attended;
          summary.am_out_total = student.am_out_total;
        }
        if (availableTimePeriods.hasPmIn) {
          summary.pm_in_attended = student.pm_in_attended;
          summary.pm_in_total = student.pm_in_total;
        }
        if (availableTimePeriods.hasPmOut) {
          summary.pm_out_attended = student.pm_out_attended;
          summary.pm_out_total = student.pm_out_total;
        }

        return summary;
      });

      if (finalAttendanceFilter === "present") {
        attendanceSummary = attendanceSummary.filter(
          (student) => student.present_count > 0
        );
      } else if (finalAttendanceFilter === "absent") {
        attendanceSummary = attendanceSummary.filter(
          (student) => student.absent_count > 0
        );
      }

      const result = {
        success: true,
        message: "Attendance summary per block retrieved successfully.",
        data: {
          event_id: Number(event_id),
          block_id: Number(block_id),
          first_event_date: firstDate,
          last_event_date: lastDate,
          available_time_periods: availableTimePeriods,
          attendance_summary: attendanceSummary,
        },
      };

      return res.status(200).json(result);
    } finally {
      connection.release();
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing the request.",
      error: error.message,
    });
  }
};

exports.getStudentAttSummary = async (req, res) => {
  try {
    const { event_id, student_id } = req.body;

    if (!event_id || !student_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: event_id and student_id.",
      });
    }

    const connection = await pool.getConnection();

    try {
      const [eventRows] = await connection.query(
        `SELECT en.name AS event_name 
         FROM events e
         JOIN event_names en ON e.event_name_id = en.id
         WHERE e.id = ?`,
        [event_id]
      );

      if (eventRows.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Event not found." });
      }

      const eventName = eventRows[0].event_name;

      const [studentRows] = await connection.query(
        `SELECT 
           CONCAT(last_name, ', ', first_name, IFNULL(CONCAT(' ', middle_name), ''), IFNULL(CONCAT(' ', suffix), '')) AS name
         FROM users
         WHERE id_number = ? AND status = 'Active'`,
        [student_id]
      );

      if (studentRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Student not found or is not active.",
        });
      }

      const studentName = studentRows[0].name;

      const timePeriodQuery = `
        SELECT 
          COUNT(CASE WHEN am_in IS NOT NULL THEN 1 END) AS has_am_in,
          COUNT(CASE WHEN am_out IS NOT NULL THEN 1 END) AS has_am_out,
          COUNT(CASE WHEN pm_in IS NOT NULL THEN 1 END) AS has_pm_in,
          COUNT(CASE WHEN pm_out IS NOT NULL THEN 1 END) AS has_pm_out
        FROM event_dates
        WHERE event_id = ?;
      `;
      const [timePeriodRows] = await connection.query(timePeriodQuery, [
        event_id,
      ]);
      const availableTimePeriods = {
        hasAmIn: timePeriodRows[0].has_am_in > 0,
        hasAmOut: timePeriodRows[0].has_am_out > 0,
        hasPmIn: timePeriodRows[0].has_pm_in > 0,
        hasPmOut: timePeriodRows[0].has_pm_out > 0,
      };

      const [eventDatesRows] = await connection.query(
        `SELECT id, DATE_FORMAT(event_date, '%Y-%m-%d') AS date, am_in, am_out, pm_in, pm_out
         FROM event_dates
         WHERE event_id = ?`,
        [event_id]
      );

      if (eventDatesRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No event dates found for the given event.",
        });
      }

      const eventDatesMap = eventDatesRows.reduce((map, eventDate) => {
        map[eventDate.id] = eventDate;
        return map;
      }, {});

      const [attendanceRows] = await connection.query(
        `SELECT event_date_id, am_in, am_out, pm_in, pm_out
         FROM attendance
         WHERE event_date_id IN (?) AND student_id_number = ?`,
        [Object.keys(eventDatesMap), student_id]
      );

      const attendanceSummary = {};

      Object.values(eventDatesMap).forEach((eventDate) => {
        const date = eventDate.date;
        const attendanceRecord = attendanceRows.find(
          (att) => att.event_date_id === eventDate.id
        );

        if (!attendanceSummary[date]) {
          attendanceSummary[date] = {
            present_count: 0,
            absent_count: 0,
            total_count: 0,
          };

          if (availableTimePeriods.hasAmIn) {
            attendanceSummary[date].am_in_attended = 0;
            attendanceSummary[date].am_in_total = 0;
          }
          if (availableTimePeriods.hasAmOut) {
            attendanceSummary[date].am_out_attended = 0;
            attendanceSummary[date].am_out_total = 0;
          }
          if (availableTimePeriods.hasPmIn) {
            attendanceSummary[date].pm_in_attended = 0;
            attendanceSummary[date].pm_in_total = 0;
          }
          if (availableTimePeriods.hasPmOut) {
            attendanceSummary[date].pm_out_attended = 0;
            attendanceSummary[date].pm_out_total = 0;
          }
        }

        let totalCount = 0;
        if (availableTimePeriods.hasAmIn && eventDate.am_in !== null) {
          totalCount += 1;
          attendanceSummary[date].am_in_total = 1;
        }
        if (availableTimePeriods.hasAmOut && eventDate.am_out !== null) {
          totalCount += 1;
          attendanceSummary[date].am_out_total = 1;
        }
        if (availableTimePeriods.hasPmIn && eventDate.pm_in !== null) {
          totalCount += 1;
          attendanceSummary[date].pm_in_total = 1;
        }
        if (availableTimePeriods.hasPmOut && eventDate.pm_out !== null) {
          totalCount += 1;
          attendanceSummary[date].pm_out_total = 1;
        }

        let presentCount = 0;
        if (attendanceRecord) {
          if (availableTimePeriods.hasAmIn && attendanceRecord.am_in) {
            presentCount += 1;
            attendanceSummary[date].am_in_attended = 1;
          }
          if (availableTimePeriods.hasAmOut && attendanceRecord.am_out) {
            presentCount += 1;
            attendanceSummary[date].am_out_attended = 1;
          }
          if (availableTimePeriods.hasPmIn && attendanceRecord.pm_in) {
            presentCount += 1;
            attendanceSummary[date].pm_in_attended = 1;
          }
          if (availableTimePeriods.hasPmOut && attendanceRecord.pm_out) {
            presentCount += 1;
            attendanceSummary[date].pm_out_attended = 1;
          }
        }

        const absentCount = totalCount - presentCount;

        attendanceSummary[date].present_count = presentCount;
        attendanceSummary[date].absent_count = absentCount;
        attendanceSummary[date].total_count = totalCount;
      });

      return res.status(200).json({
        success: true,
        message: "Student attendance summary retrieved successfully.",
        data: {
          event_name: eventName,
          student_id,
          student_name: studentName,
          available_time_periods: availableTimePeriods,
          attendance_summary: attendanceSummary,
        },
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing the request.",
      error: error.message,
    });
  }
};

exports.fetchAttendanceSummaryOfEvent = async (req, res) => {
  try {
    const { event_id, department_id, year_level_id } = req.body;

    if (!event_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameter: event_id.",
      });
    }

    const eventIdNum = Number(event_id);
    if (isNaN(eventIdNum) || !Number.isInteger(eventIdNum) || eventIdNum < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid event_id provided.",
      });
    }

    let departmentIdNum = null;
    if (department_id !== undefined) {
      departmentIdNum = Number(department_id);
      if (
        isNaN(departmentIdNum) ||
        !Number.isInteger(departmentIdNum) ||
        departmentIdNum < 1
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid department_id provided.",
        });
      }
    }

    let yearLevelIdNum = null;
    if (year_level_id !== undefined) {
      yearLevelIdNum = Number(year_level_id);
      if (
        isNaN(yearLevelIdNum) ||
        !Number.isInteger(yearLevelIdNum) ||
        yearLevelIdNum < 1
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid year_level_id provided.",
        });
      }
    }

    const connection = await pool.getConnection();

    try {
      const [eventCheck] = await connection.query(
        `SELECT en.name AS event_name, e.status AS event_status
         FROM events e
         JOIN event_names en ON e.event_name_id = en.id
         WHERE e.id = ?`,
        [eventIdNum]
      );

      if (eventCheck.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Event not found.",
        });
      }

      const eventName = eventCheck[0].event_name;
      const eventStatus = eventCheck[0].event_status;

      let baseQuery = `
        SELECT 
          u.id_number,
          CONCAT(u.last_name, ', ', u.first_name, 
            IFNULL(CONCAT(' ', u.middle_name), ''), 
            IFNULL(CONCAT(' ', u.suffix), '')) AS full_name,
          b.id AS block_id,
          b.name AS block_name,
          d.id AS department_id,
          d.code AS department_code,
          d.name AS department_name,
          b.year_level_id,
          yl.name AS year_level_name,
          c.code AS course_code,
          c.name AS course_name,
          ed.id AS event_date_id,
          ed.am_in AS schedule_am_in,
          ed.am_out AS schedule_am_out,
          ed.pm_in AS schedule_pm_in,
          ed.pm_out AS schedule_pm_out,
          a.am_in AS att_am_in,
          a.am_out AS att_am_out,
          a.pm_in AS att_pm_in,
          a.pm_out AS att_pm_out
        FROM users u
        JOIN blocks b ON u.block_id = b.id
        JOIN departments d ON b.department_id = d.id
        JOIN courses c ON b.course_id = c.id
        LEFT JOIN year_levels yl ON b.year_level_id = yl.id
        JOIN event_blocks eb ON eb.block_id = b.id AND eb.event_id = ?
        JOIN event_dates ed ON ed.event_id = ?
        LEFT JOIN attendance a ON a.student_id_number = u.id_number AND a.event_date_id = ed.id
        WHERE u.status = 'Active'
      `;

      const queryParams = [eventIdNum, eventIdNum];

      if (department_id !== undefined) {
        baseQuery += ` AND d.id = ?`;
        queryParams.push(departmentIdNum);
      }

      if (year_level_id !== undefined) {
        baseQuery += ` AND b.year_level_id = ?`;
        queryParams.push(yearLevelIdNum);
      }

      baseQuery += ` ORDER BY u.last_name, u.first_name, d.code, b.name`;

      const [rows] = await connection.query(baseQuery, queryParams);

      if (rows.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No students found for this event.",
          data: {
            event_id: eventIdNum,
            event_name: eventName,
            event_status: eventStatus,
            department_ids: [],
            year_level_ids: [],
            block_ids: [],
            departments: [],
            year_levels: [],
            blocks: [],
            students: [],
          },
        });
      }

      const studentMap = new Map();
      const departmentIdsSet = new Set();
      const yearLevelIdsSet = new Set();
      const blockIdsSet = new Set();
      const departmentsMap = new Map();
      const yearLevelsMap = new Map();
      const blocksMap = new Map();

      rows.forEach((row) => {
        const key = row.id_number;

        if (row.department_id) {
          departmentIdsSet.add(row.department_id);
          departmentsMap.set(row.department_id, {
            id: row.department_id,
            code: row.department_code,
            name: row.department_name,
          });
        }

        if (row.year_level_id) {
          yearLevelIdsSet.add(row.year_level_id);
          yearLevelsMap.set(row.year_level_id, {
            id: row.year_level_id,
            name: row.year_level_name,
          });
        }

        if (row.block_id) {
          blockIdsSet.add(row.block_id);
          blocksMap.set(row.block_id, {
            id: row.block_id,
            name: row.block_name,
            course_code: row.course_code,
            course_name: row.course_name,
            department_id: row.department_id,
            department_code: row.department_code,
            year_level_id: row.year_level_id,
          });
        }

        if (!studentMap.has(key)) {
          const nameParts = row.full_name.split(",");
          const lastName = nameParts[0].trim();
          const firstName = nameParts[1]
            ? nameParts[1].trim().split(" ")[0]
            : "";

          studentMap.set(key, {
            id_number: row.id_number,
            full_name: row.full_name,
            block_id: row.block_id,
            block_name: row.block_name,
            course_code: row.course_code,
            course_name: row.course_name,
            department_id: row.department_id,
            department_code: row.department_code,
            department_name: row.department_name,
            year_level_id: row.year_level_id,
            year_level_name: row.year_level_name,
            present_count: 0,
            absent_count: 0,
            total_sessions: 0,
            last_name: lastName,
            first_name: firstName,
          });
        }

        const student = studentMap.get(key);

        let sessionsRequired = 0;
        let sessionsAttended = 0;

        if (row.schedule_am_in != null) {
          sessionsRequired += 1;
          if (row.att_am_in === 1) sessionsAttended += 1;
        }
        if (row.schedule_am_out != null) {
          sessionsRequired += 1;
          if (row.att_am_out === 1) sessionsAttended += 1;
        }
        if (row.schedule_pm_in != null) {
          sessionsRequired += 1;
          if (row.att_pm_in === 1) sessionsAttended += 1;
        }
        if (row.schedule_pm_out != null) {
          sessionsRequired += 1;
          if (row.att_pm_out === 1) sessionsAttended += 1;
        }

        student.present_count += sessionsAttended;
        student.absent_count += sessionsRequired - sessionsAttended;
        student.total_sessions += sessionsRequired;
      });

      const students = Array.from(studentMap.values()).sort((a, b) => {
        const lastNameComparison = a.last_name.localeCompare(b.last_name);
        return lastNameComparison !== 0
          ? lastNameComparison
          : a.first_name.localeCompare(b.first_name);
      });

      const departmentIds = Array.from(departmentIdsSet).sort((a, b) => a - b);
      const yearLevelIds = Array.from(yearLevelIdsSet).sort((a, b) => a - b);
      const blockIds = Array.from(blockIdsSet).sort((a, b) => a - b);

      const departments = Array.from(departmentsMap.values()).sort((a, b) =>
        a.code.localeCompare(b.code)
      );
      const yearLevels = Array.from(yearLevelsMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      const blocks = Array.from(blocksMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      );

      return res.status(200).json({
        success: true,
        message: "Event attendance summary retrieved successfully.",
        data: {
          event_id: eventIdNum,
          event_name: eventName,
          event_status: eventStatus,
          department_ids: departmentIds,
          year_level_ids: yearLevelIds,
          block_ids: blockIds,
          departments: departments,
          year_levels: yearLevels,
          blocks: blocks,
          students: students,
        },
      });
    } catch (dbError) {
      console.error("Database error:", dbError);
      return res.status(500).json({
        success: false,
        message: "Database error while fetching event attendance summary.",
        error: dbError.message,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("An error occurred:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing the request.",
      error: error.message,
    });
  }
};
