const { pool } = require("../config/db");

const handleError = (res, error, defaultMessage = "Internal server error") => {
  console.error(error);
  return res.status(error.status || 500).json({
    success: false,
    message: error.message || defaultMessage,
  });
};

exports.getYearLevel = async (req, res) => {
  try {
    const [yearlevel] = await pool.query("SELECT * FROM view_year_levels");

    if (!yearlevel.length) {
      return res
        .status(404)
        .json({ success: false, message: "No year level found" });
    }

    return res.status(200).json({ success: true, yearlevel });
  } catch (error) {
    return handleError(res, error);
  }
};
