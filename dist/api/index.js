"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const node_path_1 = __importDefault(require("node:path"));
const command_handler_1 = require("./command-handler");
const webhooks_handler_1 = require("./webhooks-handler");
const app = (0, express_1.default)();
const port = Number(process.env.PORT ?? 3000);
app.use(express_1.default.json());
app.use("/demo", express_1.default.static(node_path_1.default.join(process.cwd(), "public", "demo")));
app.get("/health", (_req, res) => {
    res.json({ ok: true });
});
app.post("/campaigns", (req, res) => {
    void (0, command_handler_1.createCampaignHandler)(req, res);
});
app.get("/campaigns/:id/metrics", (req, res) => {
    void (0, command_handler_1.getCampaignMetricsHandler)(req, res);
});
app.post("/webhooks/calls/:provider", (req, res) => {
    void (0, webhooks_handler_1.callWebhookHandler)(req, res);
});
app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
});
