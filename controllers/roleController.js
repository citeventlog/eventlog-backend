const { pool } = require("../config/db");

const handleError = (res, error, defaultMessage = "Internal server error") => {
  console.error(error);
  return res.status(error.status || 500).json({
    success: false,
    message: error.message || defaultMessage,
  });
};

exports.getRoles = async (req, res) => {
  try {
    const [roles] = await pool.query("SELECT * FROM view_roles");

    if (!roles.length) {
      return res
        .status(404)
        .json({ success: false, message: "No roles found" });
    }

    return res.status(200).json({ success: true, roles });
  } catch (error) {
    return handleError(res, error);
  }
};
