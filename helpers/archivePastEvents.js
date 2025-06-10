const { pool } = require("../config/db");

const archivePastEvents = async () => {
  try {
    const [eventsToArchive] = await pool.query(`
      SELECT 
        events.id AS event_id, 
        event_names.name AS event_name, 
        latestEventDates.last_event_date
      FROM events
      JOIN event_names ON events.event_name_id = event_names.id
      JOIN (
        SELECT event_id, MAX(event_date) AS last_event_date
        FROM event_dates
        GROUP BY event_id
      ) AS latestEventDates ON events.id = latestEventDates.event_id
      WHERE events.status = 'Approved'
        AND latestEventDates.last_event_date < CURDATE();
    `);

    if (eventsToArchive.length === 0) return;

    const eventIdsToArchive = eventsToArchive.map((event) => event.event_id);
    await pool.query(`UPDATE events SET status = 'Archived' WHERE id IN (?)`, [
      eventIdsToArchive,
    ]);
  } catch (error) {
    console.error(error);
  }
};

module.exports = { archivePastEvents };
