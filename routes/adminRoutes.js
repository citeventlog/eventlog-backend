const express = require("express");
const router = express.Router();

const adminController = require("../controllers/adminController");

router.route("/").get(adminController.getAllAdmins);
router.route("/:id_number").put(adminController.disableAdmin);
router.route("/:id_number").get(adminController.fetchAdminById);
router.route("/add-admin").post(adminController.addAdmin);
router.route("/edit/:id_number").put(adminController.editAdmin);

module.exports = router;
