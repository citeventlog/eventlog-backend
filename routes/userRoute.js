const express = require("express");
const router = express.Router();

const userController = require("../controllers/userController");

router.post("/change-password", userController.changePassword);

router.get("/", userController.getAllUsers);
router.get("/id-number/:id", userController.getUserByID);
router.put("/edit/:id", userController.editUser);
router.put("/disable/:id", userController.disableUser);
router.post("/add-user", userController.addUser);

module.exports = router;
