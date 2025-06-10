const express = require("express");
const router = express.Router();

const yearLevelController = require("../controllers/yearLevelController");

router.route("/").get(yearLevelController.getYearLevel);

module.exports = router;
