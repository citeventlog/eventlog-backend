const express = require("express");
const router = express.Router();

const attendanceController = require("../controllers/attendanceController");

router.route("/sync").post(attendanceController.syncAttendance);
router
  .route("/user/ongoing/events")
  .post(attendanceController.fetchUserOngoingEvents);
router
  .route("/user/past/events")
  .post(attendanceController.fetchUserPastEvents);

router
  .route("/admin/ongoing/events")
  .post(attendanceController.fetchAllOngoingEvents);
router
  .route("/admin/past/events")
  .post(attendanceController.fetchAllPastEvents);

router.route("/events/blocks").post(attendanceController.fetchBlocksOfEvents);
router
  .route("/events/block/students")
  .post(attendanceController.fetchStudentAttendanceByEventAndBlock);

router
  .route("/summary")
  .post(attendanceController.fetchAttendanceSummaryPerBlock);
router
  .route("/student/summary")
  .post(attendanceController.getStudentAttSummary);

router
  .route("/event/summary")
  .post(attendanceController.fetchAttendanceSummaryOfEvent);

module.exports = router;
