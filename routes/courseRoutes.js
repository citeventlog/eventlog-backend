const express = require("express");
const router = express.Router();

const courseController = require("../controllers/courseController");

router.route("/").get(courseController.getAllCourses);
router.route("/:id").put(courseController.disableCourse);
router.route("/:id").get(courseController.fetchCourseById);
router.route("/add-course").post(courseController.addCourse);
router.route("/edit/:id").put(courseController.editCourse);
router
  .route("/departments/:department_id")
  .get(courseController.getCoursesByDepartmentId);

module.exports = router;
