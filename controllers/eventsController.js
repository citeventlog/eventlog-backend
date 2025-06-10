const { pool } = require("../config/db");

exports.getUpcomingEvents = async (req, res) => {
  const { block_id } = req.body;

  if (block_id && isNaN(block_id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid block_id. Please provide a numeric value.",
    });
  }

  try {
    let query = `
      SELECT * 
      FROM view_upcoming_events 
      WHERE LOWER(TRIM(status)) = 'approved'
    `;
    let queryParams = [];

    if (block_id !== null && block_id !== undefined) {
      query += `
        AND (
          FIND_IN_SET(?, block_ids) > 0
          OR JSON_CONTAINS(block_ids, ?)
        )
      `;
      queryParams.push(block_id, `"${block_id}"`);
    }

    const [events] = await pool.query(query, queryParams);

    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3);
    const threeDaysAfter = new Date(today);
    threeDaysAfter.setDate(today.getDate() + 3);

    const filteredEvents = events.filter((event) => {
      try {
        const eventDates = JSON.parse(event.event_dates);
        const firstEventDate = new Date(eventDates[0]);
        const lastEventDate = new Date(eventDates[eventDates.length - 1]);

        const within3DaysBefore =
          firstEventDate >= threeDaysAgo && firstEventDate <= today;
        const within3DaysAfter =
          firstEventDate > today && firstEventDate <= threeDaysAfter;
        const duringEvent = today >= firstEventDate && today <= lastEventDate;

        return within3DaysBefore || within3DaysAfter || duringEvent;
      } catch (error) {
        return false;
      }
    });

    const formatDate = (date) => {
      const options = { year: "numeric", month: "long", day: "numeric" };
      return new Date(date).toLocaleDateString("en-US", options);
    };

    const formattedEvents = filteredEvents
      .map((event) => {
        try {
          const eventDates = JSON.parse(event.event_dates);
          const firstEventDate = eventDates[0];
          const lastEventDate = eventDates[eventDates.length - 1];

          const blockIds = JSON.parse(event.block_ids);
          const departmentIds = event.department_ids.split(",").map(String);
          const eventDateIds = JSON.parse(event.event_date_ids);

          return {
            ...event,
            event_dates: eventDates,
            block_ids: blockIds,
            department_ids: departmentIds,
            event_date_ids: eventDateIds,
            first_event_date: formatDate(firstEventDate),
            last_event_date: formatDate(lastEventDate),
          };
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);

    const response = {
      success: true,
      events: formattedEvents,
      total: formattedEvents.length,
    };

    if (formattedEvents.length === 0) {
      response.message = "No upcoming events found";
      response.events = [];
      response.total = 0;
    }

    const io = req.app.get("io");
    if (io) {
      if (block_id) {
        io.to(`block-${block_id}`).emit("upcoming-events-updated", {
          block_id,
          events: formattedEvents,
          total: formattedEvents.length,
          timestamp: new Date(),
        });
      }

      io.emit("events-list-updated", {
        type: "upcoming",
        events: formattedEvents,
        total: formattedEvents.length,
        timestamp: new Date(),
      });
    }

    return res.json(response);
  } catch (error) {
    console.error("Error fetching upcoming events:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Something went wrong" });
  }
};

exports.addEvent = async (req, res) => {
  const {
    event_name_id,
    venue,
    dates: eventDates,
    description,
    block_ids: blockIds,
    am_in,
    am_out,
    pm_in,
    pm_out,
    duration,
    admin_id_number: created_by,
    status = "Pending",
  } = req.body;

  if (
    !event_name_id ||
    !venue ||
    !Array.isArray(eventDates) ||
    eventDates.length === 0 ||
    !Array.isArray(blockIds) ||
    blockIds.length === 0 ||
    !created_by
  ) {
    return res
      .status(400)
      .json({ message: "Missing or invalid required fields." });
  }

  const allowedStatuses = ["Pending", "Approved"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      message: `Invalid status. Allowed values are: ${allowedStatuses.join(
        ", "
      )}.`,
    });
  }

  const db = await pool.getConnection();
  try {
    await db.beginTransaction();

    const [schoolYearSemesterRows] = await db.query(
      `SELECT id FROM school_year_semesters WHERE status = 'Active' LIMIT 1`
    );

    if (!schoolYearSemesterRows || schoolYearSemesterRows.length === 0) {
      await db.rollback();
      return res
        .status(400)
        .json({ message: "No active school year semester found." });
    }
    const school_year_semester_id = schoolYearSemesterRows[0].id;

    const [existingEventNameRows] = await db.query(
      `SELECT id, name FROM event_names WHERE id = ?`,
      [event_name_id]
    );
    if (!existingEventNameRows || existingEventNameRows.length === 0) {
      await db.rollback();
      return res.status(400).json({ message: "Invalid event name ID." });
    }

    const [existingAdminRows] = await db.query(
      `SELECT id_number, role_id, first_name, last_name FROM admins WHERE id_number = ?`,
      [created_by]
    );
    if (!existingAdminRows || existingAdminRows.length === 0) {
      await db.rollback();
      return res.status(400).json({ message: "Invalid admin ID." });
    }
    const isAdminRole4 = existingAdminRows[0].role_id === 4;
    const adminInfo = existingAdminRows[0];

    const uniqueDates = [...new Set(eventDates)].sort();
    const uniqueBlocks = [...new Set(blockIds.map(String))].sort();

    const [existingEventViewRows] = await db.query(
      `SELECT event_id, event_dates, block_ids
       FROM view_existing_events
       WHERE event_name_id = ? 
         AND venue = ? 
         AND event_status IN ('Pending', 'Approved')`,
      [event_name_id, venue]
    );

    if (existingEventViewRows && existingEventViewRows.length > 0) {
      const isDuplicate = existingEventViewRows.some((existing) => {
        const existingDates = existing.event_dates
          ? existing.event_dates.split(",").sort()
          : [];
        const existingBlocks = existing.block_ids
          ? existing.block_ids.split(",").sort()
          : [];

        const datesMatch =
          JSON.stringify(uniqueDates) === JSON.stringify(existingDates);
        const blocksMatch =
          JSON.stringify(uniqueBlocks) === JSON.stringify(existingBlocks);

        return datesMatch && blocksMatch;
      });

      if (isDuplicate) {
        await db.rollback();
        return res.status(409).json({
          message:
            "Event with the exact same details already exists. Please go to the edit page to add dates.",
        });
      }
    }

    const [eventResult] = await db.query(
      `INSERT INTO events
        (event_name_id, school_year_semester_id, venue, description, scan_personnel, created_by, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event_name_id,
        school_year_semester_id,
        venue,
        description,
        "Year Level Representatives, Governor, or Year Level Advisers",
        created_by,
        isAdminRole4 ? "Approved" : "Pending",
      ]
    );
    const eventId = eventResult.insertId;

    const dateValues = uniqueDates.map((event_date) => [
      eventId,
      event_date,
      am_in,
      am_out,
      pm_in,
      pm_out,
      duration,
    ]);
    await db.query(
      `INSERT INTO event_dates
        (event_id, event_date, am_in, am_out, pm_in, pm_out, duration)
        VALUES ?`,
      [dateValues]
    );

    const blockValues = uniqueBlocks.map((block_id) => [eventId, block_id]);
    await db.query(`INSERT INTO event_blocks (event_id, block_id) VALUES ?`, [
      blockValues,
    ]);

    await db.commit();

    if (isAdminRole4) {
      const [newEventData] = await db.query(
        `SELECT 
          e.id as event_id,
          e.event_name_id,
          en.name as event_name,
          e.venue,
          e.description,
          e.status,
          e.created_by,
          e.scan_personnel,
          GROUP_CONCAT(DISTINCT DATE_FORMAT(ed.event_date, '%Y-%m-%d') ORDER BY ed.event_date) as event_dates,
          GROUP_CONCAT(DISTINCT eb.block_id ORDER BY eb.block_id) as block_ids,
          MAX(ed.am_in) as am_in,
          MAX(ed.am_out) as am_out,
          MAX(ed.pm_in) as pm_in,
          MAX(ed.pm_out) as pm_out,
          MAX(ed.duration) as duration
        FROM events e
        JOIN event_names en ON e.event_name_id = en.id
        LEFT JOIN event_dates ed ON e.id = ed.event_id
        LEFT JOIN event_blocks eb ON e.id = eb.event_id
        WHERE e.id = ?
        GROUP BY e.id, e.event_name_id, en.name, e.venue, e.description, e.status, e.created_by, e.scan_personnel`,
        [eventId]
      );

      if (newEventData && newEventData.length > 0) {
        const eventData = {
          ...newEventData[0],
          event_dates: newEventData[0].event_dates
            ? newEventData[0].event_dates.split(",")
            : [],
          block_ids: newEventData[0].block_ids
            ? newEventData[0].block_ids.split(",").map((id) => parseInt(id))
            : [],
          created_by_name: `${adminInfo.first_name} ${adminInfo.last_name}`,
          is_new_approved: true,
        };

        if (req.io) {
          req.io.to("all-events").emit("newApprovedEvent", {
            type: "EVENT_APPROVED",
            data: eventData,
            message: `New event "${eventData.event_name}" has been approved and added to the schedule`,
            timestamp: new Date().toISOString(),
          });

          req.io.to("all-events").emit("new-event-added", {
            event: eventData,
            block_ids: uniqueBlocks.map((id) => parseInt(id)),
            timestamp: new Date().toISOString(),
          });

          req.io.to("all-events").emit("events-list-updated", {
            type: "upcoming",
            events: [eventData],
            total: 1,
            timestamp: new Date(),
          });

          uniqueBlocks.forEach((block_id) => {
            req.io.to(`block-${block_id}`).emit("newApprovedEvent", {
              type: "EVENT_APPROVED",
              data: eventData,
              message: `New event "${eventData.event_name}" has been approved and added to the schedule`,
              timestamp: new Date().toISOString(),
            });

            req.io.to(`block-${block_id}`).emit("upcoming-events-updated", {
              block_id: parseInt(block_id),
              events: [eventData],
              total: 1,
              timestamp: new Date(),
            });

            req.io.to(`block-${block_id}`).emit("new-event-added", {
              event: eventData,
              block_ids: uniqueBlocks.map((id) => parseInt(id)),
              timestamp: new Date().toISOString(),
            });
          });

          req.io.emit("events-list-updated", {
            type: "upcoming",
            events: [eventData],
            total: 1,
            timestamp: new Date(),
          });
        }
      }
    }

    return res.status(201).json({
      success: true,
      message: isAdminRole4
        ? "Event created and automatically approved successfully"
        : "Event created successfully",
      event_id: eventId,
      auto_approved: isAdminRole4,
    });
  } catch (error) {
    console.error("Error adding event:", error);
    await db.rollback();
    return res.status(500).json({ message: "Failed to create event" });
  } finally {
    db.release();
  }
};

exports.editEvent = async (req, res) => {
  const {
    event_id,
    event_name_id,
    venue,
    dates: event_dates,
    description,
    block_ids,
    am_in,
    am_out,
    pm_in,
    pm_out,
    duration,
    admin_id_number: updated_by,
  } = req.body;

  if (
    !event_id ||
    !event_name_id ||
    !venue ||
    !Array.isArray(event_dates) ||
    event_dates.length === 0 ||
    !Array.isArray(block_ids) ||
    block_ids.length === 0 ||
    !updated_by
  ) {
    return res
      .status(400)
      .json({ message: "Missing or invalid required fields." });
  }

  const db = await pool.getConnection();
  try {
    await db.beginTransaction();

    console.log(`Inspecting database for event ID: ${event_id}`);

    const [eventDates] = await db.query(
      `SELECT id FROM event_dates WHERE event_id = ?`,
      [event_id]
    );

    console.log(`Found ${eventDates.length} event dates:`, eventDates);

    for (const dateRow of eventDates) {
      const dateId = dateRow.id;
      console.log(`Checking attendance for event date ID: ${dateId}`);

      const [attendanceRecords] = await db.query(
        `SELECT id FROM attendance WHERE event_date_id = ?`,
        [dateId]
      );

      console.log(
        `Found ${attendanceRecords.length} attendance records for date ID: ${dateId}`
      );

      if (attendanceRecords.length > 0) {
        for (const attRecord of attendanceRecords) {
          const [confirmRecord] = await db.query(
            `SELECT * FROM attendance WHERE id = ?`,
            [attRecord.id]
          );

          console.log(
            `Confirmed attendance record ${attRecord.id}:`,
            confirmRecord[0]
          );

          console.log(`Deleting attendance record ID: ${attRecord.id}`);
          const result = await db.query(`DELETE FROM attendance WHERE id = ?`, [
            attRecord.id,
          ]);

          console.log(`Deletion result:`, result);

          const [verifyDelete] = await db.query(
            `SELECT * FROM attendance WHERE id = ?`,
            [attRecord.id]
          );

          if (verifyDelete.length > 0) {
            console.error(
              `Failed to delete attendance record: ${attRecord.id}`
            );
            await db.rollback();
            return res.status(500).json({
              message: `Failed to delete attendance record: ${attRecord.id}`,
            });
          } else {
            console.log(
              `Successfully deleted attendance record: ${attRecord.id}`
            );
          }
        }
      }
    }

    let allAttendanceDeleted = true;
    for (const dateRow of eventDates) {
      const dateId = dateRow.id;
      const [remainingAttendance] = await db.query(
        `SELECT COUNT(*) as count FROM attendance WHERE event_date_id = ?`,
        [dateId]
      );

      if (remainingAttendance[0].count > 0) {
        console.error(
          `Event date ID ${dateId} still has ${remainingAttendance[0].count} attendance records!`
        );
        allAttendanceDeleted = false;
      }
    }

    if (!allAttendanceDeleted) {
      console.error("Failed to delete all attendance records");
      await db.rollback();
      return res.status(500).json({
        message: "Failed to delete all attendance records",
      });
    }

    const [schoolYearSemester] = await db.query(
      `SELECT id FROM school_year_semesters WHERE status = 'Active' LIMIT 1`
    );

    if (!schoolYearSemester || schoolYearSemester.length === 0) {
      await db.rollback();
      return res
        .status(400)
        .json({ message: "No active school year semester found." });
    }
    const school_year_semester_id = schoolYearSemester[0].id;

    const [existingEvent] = await db.query(
      `SELECT id FROM events WHERE id = ?`,
      [event_id]
    );

    if (!existingEvent || existingEvent.length === 0) {
      await db.rollback();
      return res.status(400).json({ message: "Event not found." });
    }

    const [existingEventName] = await db.query(
      `SELECT id FROM event_names WHERE id = ?`,
      [event_name_id]
    );

    if (!existingEventName || existingEventName.length === 0) {
      await db.rollback();
      return res.status(400).json({ message: "Invalid event name ID." });
    }

    const [existingAdmin] = await db.query(
      `SELECT id_number FROM admins WHERE id_number = ?`,
      [updated_by]
    );

    if (!existingAdmin || existingAdmin.length === 0) {
      await db.rollback();
      return res.status(400).json({ message: "Invalid admin ID." });
    }

    const uniqueDates = [...new Set(event_dates)].sort();
    const uniqueBlocks = [...new Set(block_ids)].map(String).sort();

    const [existingEventView] = await db.query(
      `SELECT event_id, event_dates, block_ids
       FROM view_existing_events
       WHERE event_name_id = ? 
         AND venue = ? 
         AND event_status IN ('Pending', 'Approved') AND event_id != ?`,
      [event_name_id, venue, event_id]
    );

    if (existingEventView && existingEventView.length > 0) {
      const isDuplicate = existingEventView.some((existing) => {
        const existingDates = existing.event_dates
          ? existing.event_dates.split(",").sort()
          : [];
        const existingBlocks = existing.block_ids
          ? existing.block_ids.split(",").sort()
          : [];

        const currentDatesMatch =
          JSON.stringify(uniqueDates) === JSON.stringify(existingDates);
        const currentBlocksMatch =
          JSON.stringify(uniqueBlocks) === JSON.stringify(existingBlocks);

        return currentDatesMatch && currentBlocksMatch;
      });

      if (isDuplicate) {
        await db.rollback();
        return res.status(409).json({
          message:
            "Event with the exact same details already exists. Please go to the edit page to add dates.",
        });
      }
    }

    await db.query(
      `UPDATE events
        SET event_name_id = ?, school_year_semester_id = ?, venue = ?, description = ?, created_by = ?
        WHERE id = ?`,
      [
        event_name_id,
        school_year_semester_id,
        venue,
        description,
        updated_by,
        event_id,
      ]
    );

    console.log(`Deleting event dates for event ID: ${event_id}`);
    await db.query(`DELETE FROM event_dates WHERE event_id = ?`, [event_id]);

    const dateValues = uniqueDates.map((event_date) => [
      event_id,
      event_date,
      am_in,
      am_out,
      pm_in,
      pm_out,
      duration,
    ]);

    await db.query(
      `INSERT INTO event_dates
        (event_id, event_date, am_in, am_out, pm_in, pm_out, duration)
        VALUES ?`,
      [dateValues]
    );

    await db.query(`DELETE FROM event_blocks WHERE event_id = ?`, [event_id]);

    const blockValues = uniqueBlocks.map((block_id) => [event_id, block_id]);
    await db.query(`INSERT INTO event_blocks (event_id, block_id) VALUES ?`, [
      blockValues,
    ]);

    await db.commit();

    return res.status(200).json({
      success: true,
      message: "Event updated successfully",
      event_id,
    });
  } catch (error) {
    console.error("Error updating event:", error);

    await db.rollback();
    return res.status(500).json({
      message: "Failed to update event",
    });
  } finally {
    db.release();
  }
};

exports.getAllEventNames = async (req, res) => {
  try {
    const [eventNames] = await pool.query(
      "SELECT id, name, status FROM event_names ORDER BY name ASC"
    );

    return res.json({ success: true, eventNames });
  } catch (error) {
    console.error("Error fetching event names:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch event names." });
  }
};

exports.getEditableEvents = async (req, res) => {
  try {
    const db = await pool.getConnection();
    const searchQuery = req.query.search || "";

    const [events] = await db.query(
      `
      SELECT * FROM view_editable_events
      WHERE event_name LIKE ? OR venue LIKE ?
      ORDER BY status, event_dates
      `,
      [`%${searchQuery}%`, `%${searchQuery}%`]
    );

    const simpleEvents = events.map((event) => {
      const blockIds = event.block_ids
        ? event.block_ids.split(",").map((id) => id.trim())
        : [];
      const blockNames = event.block_names
        ? event.block_names.split(",").map((name) => name.trim())
        : [];
      const dates = event.event_dates
        ? event.event_dates.split(",").map((date) => date.trim())
        : [];

      return {
        id: event.event_id,
        name: event.event_name,
        venue: event.venue,
        status: event.status,
        dates: dates,
        am_in: event.am_in,
        am_out: event.am_out,
        pm_in: event.pm_in,
        pm_out: event.pm_out,
        duration: event.duration,
        blocks: {
          ids: blockIds,
          names: blockNames,
        },
        created_by: event.created_by_name,
        approved_by: event.approved_by_name || "Not approved",
      };
    });

    res.json({
      success: true,
      events: simpleEvents,
    });

    db.release();
  } catch (error) {
    console.error("Error getting events:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get events",
    });
  }
};

exports.getEventById = async (req, res) => {
  const { id } = req.params;

  try {
    const [events] = await pool.query(
      `SELECT * FROM view_existing_events WHERE event_id = ?`,
      [id]
    );

    if (events.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found" });
    }

    const event = events[0];

    return res.json({ success: true, event });
  } catch (error) {
    console.error("Error fetching event by ID:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.updateEventById = async (req, res) => {
  const {
    event_id,
    event_name_id,
    venue,
    dates: event_dates,
    description,
    block_ids,
    am_in,
    am_out,
    pm_in,
    pm_out,
    duration,
    admin_id_number: updated_by,
  } = req.body;

  if (
    !event_id ||
    !event_name_id ||
    !venue ||
    !Array.isArray(event_dates) ||
    event_dates.length === 0 ||
    !Array.isArray(block_ids) ||
    block_ids.length === 0 ||
    !updated_by
  ) {
    return res
      .status(400)
      .json({ message: "Missing or invalid required fields." });
  }

  const db = await pool.getConnection();
  try {
    await db.beginTransaction();

    const [schoolYearSemester] = await db.query(
      `SELECT id FROM school_year_semesters WHERE status = 'Active' LIMIT 1`
    );

    if (!schoolYearSemester || schoolYearSemester.length === 0) {
      await db.rollback();
      return res
        .status(400)
        .json({ message: "No active school year semester found." });
    }
    const school_year_semester_id = schoolYearSemester[0].id;

    const [existingEvent] = await db.query(
      `SELECT id FROM events WHERE id = ?`,
      [event_id]
    );

    if (!existingEvent || existingEvent.length === 0) {
      await db.rollback();
      return res.status(400).json({ message: "Event not found." });
    }

    const [existingEventName] = await db.query(
      `SELECT id FROM event_names WHERE id = ?`,
      [event_name_id]
    );

    if (!existingEventName || existingEventName.length === 0) {
      await db.rollback();
      return res.status(400).json({ message: "Invalid event name ID." });
    }

    const [existingAdmin] = await db.query(
      `SELECT id_number FROM admins WHERE id_number = ?`,
      [updated_by]
    );

    if (!existingAdmin || existingAdmin.length === 0) {
      await db.rollback();
      return res.status(400).json({ message: "Invalid admin ID." });
    }

    const uniqueDates = [...new Set(event_dates)].sort();
    const uniqueBlocks = [...new Set(block_ids)].map(String).sort();

    const [existingEventView] = await db.query(
      `SELECT event_id, event_dates, block_ids
       FROM view_existing_events
       WHERE event_name_id = ? 
         AND venue = ? 
         AND event_status IN ('Pending', 'Approved') AND event_id != ?`,
      [event_name_id, venue, event_id]
    );

    if (existingEventView && existingEventView.length > 0) {
      const isDuplicate = existingEventView.some((existing) => {
        const existingDates = existing.event_dates
          ? existing.event_dates.split(",").sort()
          : [];
        const existingBlocks = existing.block_ids
          ? existing.block_ids.split(",").sort()
          : [];

        const currentDatesMatch =
          JSON.stringify(uniqueDates) === JSON.stringify(existingDates);
        const currentBlocksMatch =
          JSON.stringify(uniqueBlocks) === JSON.stringify(existingBlocks);

        return currentDatesMatch && currentBlocksMatch;
      });

      if (isDuplicate) {
        await db.rollback();
        return res.status(409).json({
          message:
            "Event with the exact same details already exists. Please go to the edit page to add dates.",
        });
      }
    }

    await db.query(
      `UPDATE events
        SET event_name_id = ?, school_year_semester_id = ?, venue = ?, description = ?, created_by = ?
        WHERE id = ?`,
      [
        event_name_id,
        school_year_semester_id,
        venue,
        description,
        updated_by,
        event_id,
      ]
    );

    await db.query(`DELETE FROM event_dates WHERE event_id = ?`, [event_id]);

    const dateValues = uniqueDates.map((event_date) => [
      event_id,
      event_date,
      am_in,
      am_out,
      pm_in,
      pm_out,
      duration,
    ]);

    await db.query(
      `INSERT INTO event_dates
        (event_id, event_date, am_in, am_out, pm_in, pm_out, duration)
        VALUES ?`,
      [dateValues]
    );

    await db.query(`DELETE FROM event_blocks WHERE event_id = ?`, [event_id]);

    const blockValues = uniqueBlocks.map((block_id) => [event_id, block_id]);
    await db.query(`INSERT INTO event_blocks (event_id, block_id) VALUES ?`, [
      blockValues,
    ]);

    await db.commit();

    return res.status(200).json({
      success: true,
      message: "Event updated successfully",
      event_id,
    });
  } catch (error) {
    console.error("Error updating event:", error);

    await db.rollback();
    return res.status(500).json({
      message: "Failed to update event",
    });
  } finally {
    db.release();
  }
};

exports.getAllEvents = async (req, res) => {
  try {
    const [events] = await pool.query("SELECT * FROM view_events");

    if (!events.length) {
      return res
        .status(404)
        .json({ success: false, message: "No events found" });
    }

    return res.status(200).json({ success: true, events });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.deleteEvent = async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res
      .status(400)
      .json({ success: false, message: "Event ID is required" });
  }

  try {
    const [result] = await pool.query(
      `UPDATE events SET status = 'deleted' WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found" });
    }

    return res.json({
      success: true,
      message: "Event soft deleted successfully",
    });
  } catch (error) {
    console.error("Error soft deleting event:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to soft delete event" });
  }
};

exports.approveEventById = async (req, res) => {
  const { id } = req.params;
  const { admin_id_number } = req.body;

  if (!id || !admin_id_number) {
    return res.status(400).json({
      success: false,
      message: "Event ID and Admin ID are required",
    });
  }

  const db = await pool.getConnection();
  try {
    await db.beginTransaction();

    const [updateResult] = await db.query(
      `UPDATE events SET status = 'Approved', approved_by = ? WHERE id = ?`,
      [admin_id_number, id]
    );

    if (updateResult.affectedRows === 0) {
      await db.rollback();
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const [eventDates] = await db.query(
      `SELECT id, event_date FROM event_dates WHERE event_id = ?`,
      [id]
    );

    const [eventBlocks] = await db.query(
      `SELECT block_id FROM event_blocks WHERE event_id = ?`,
      [id]
    );

    if (eventDates.length === 0 || eventBlocks.length === 0) {
      await db.rollback();
      return res.status(400).json({
        success: false,
        message: "No event dates or blocks found for this event",
      });
    }

    await db.commit();

    return res.json({
      success: true,
      message: "Event approved successfully",
    });
  } catch (error) {
    console.error("Error approving event:", error);

    await db.rollback();
    return res.status(500).json({
      success: false,
      message: "Failed to approve event",
    });
  } finally {
    db.release();
  }
};
