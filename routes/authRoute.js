const express = require("express");
const router = express.Router();

const authController = require("../controllers/authController");

router.route("/signup").post(authController.signup);
router.route("/login").post(authController.login);
router.route("/reset-password").post(authController.resetPassword);
router.route("/reset-password/confirm").post(authController.confirmPassword);

module.exports = router;
