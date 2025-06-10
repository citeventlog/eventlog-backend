const express = require("express");
const router = express.Router();

const departmentController = require("../controllers/departmentController");

router.route("/departments").get(departmentController.getDepartments);
router.route("/departments/:id").get(departmentController.getDepartmentById);
router.route("/departments").post(departmentController.addDepartment);
router.route("/departments/:id").put(departmentController.updateDepartment);
router
  .route("/departments/dis/:id")
  .put(departmentController.disableDepartment);

module.exports = router;
