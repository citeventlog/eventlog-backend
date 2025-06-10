const { server } = require("./app");
const { pool } = require("./config/db");
const cron = require("node-cron");
const { archivePastEvents } = require("./helpers/archivePastEvents");

(async () => {
  try {
    const connection = await pool.getConnection();
    connection.release();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, async () => {
      await archivePastEvents();
    });

    cron.schedule("0 0 * * *", async () => {
      await archivePastEvents();
    });
  } catch (error) {
    console.error("Error connecting to the database:", error);
  }
})();
