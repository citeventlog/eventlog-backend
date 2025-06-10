const { pool } = require("../config/db");
const handleError = (res, error, defaultMessage = "Internal server error") => {
  console.error(error);
  return res.status(error.status || 500).json({
    success: false,
    message: error.message || defaultMessage,
  });
};

exports.addEventName = async (req, res) => {
  let name = req.body.name;

  if (name && typeof name === "object" && name.name) {
    name = name.name;
  }

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Event name must be a non-empty string.",
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [existingEvent] = await connection.query(
      "SELECT * FROM event_names WHERE name = ?",
      [name.trim()]
    );

    if (existingEvent.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "Event name already exists.",
      });
    }

    const [result] = await connection.query(
      "INSERT INTO event_names (name) VALUES (?)",
      [name.trim()]
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      eventName: { id: result.insertId, name: name.trim() },
    });
  } catch (error) {
    await connection.rollback().catch(console.error);
    console.error(error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to add event name.",
    });
  } finally {
    connection.release();
  }
};

exports.getAllEventNames = async (req, res) => {
  const { search, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;
  try {
    let query = "SELECT * FROM event_names";
    const queryParams = [];
    if (search) {
      query += " WHERE name LIKE ?";
      queryParams.push(`%${search}%`);
    }
    query += " LIMIT ? OFFSET ?";
    queryParams.push(parseInt(limit), parseInt(offset));
    const [eventNames] = await pool.query(query, queryParams);
    const countQuery = search
      ? "SELECT COUNT(*) AS total FROM event_names WHERE name LIKE ?"
      : "SELECT COUNT(*) AS total FROM event_names";
    const countParams = search ? [`%${search}%`] : [];
    const [totalCountResult] = await pool.query(countQuery, countParams);
    const total = totalCountResult[0].total;
    if (!eventNames.length) {
      return res.status(404).json({
        success: false,
        message: "No event names found.",
      });
    }
    return res.status(200).json({
      success: true,
      data: eventNames,
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

exports.getEventNameByID = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [eventName] = await connection.query(
      "SELECT * FROM event_names WHERE id = ?",
      [id]
    );
    if (!eventName.length) {
      return res.status(404).json({
        success: false,
        message: "Event name not found.",
      });
    }
    return res.status(200).json({
      success: true,
      data: eventName[0],
    });
  } catch (error) {
    return handleError(res, error);
  } finally {
    if (connection) connection.release();
  }
};

exports.updateEventName = async (req, res) => {
  const { id } = req.params;
  const { name, status } = req.body;

  if (!id || isNaN(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid event ID.",
    });
  }

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Event name must be a non-empty string.",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [existingEventName] = await connection.query(
      "SELECT id, name, status FROM event_names WHERE id = ?",
      [id]
    );

    if (!existingEventName.length) {
      return res.status(404).json({
        success: false,
        message: "Event name not found.",
      });
    }

    const currentData = existingEventName[0];

    if (
      currentData.name === name &&
      (status === undefined || currentData.status === status)
    ) {
      return res.status(200).json({
        success: true,
        message: "No changes detected. Event name remains the same.",
      });
    }

    await connection.query(
      "UPDATE event_names SET name = ?, status = ? WHERE id = ?",
      [name, status, id]
    );

    return res.status(200).json({
      success: true,
      message: "Event name updated successfully.",
      data: { id, name, status: status ?? currentData.status },
    });
  } catch (error) {
    return handleError(res, error);
  } finally {
    if (connection) connection.release();
  }
};

exports.disableEventName = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [eventName] = await connection.query(
      "SELECT * FROM event_names WHERE id = ?",
      [id]
    );
    if (!eventName.length) {
      return res.status(404).json({
        success: false,
        message: "Event name not found.",
      });
    }
    await connection.query(
      "UPDATE event_names SET status = 'Disabled' WHERE id = ?",
      [id]
    );
    return res.status(200).json({
      success: true,
      message: "Event name status set to deleted successfully.",
    });
  } catch (error) {
    return handleError(res, error);
  } finally {
    if (connection) connection.release();
  }
};
