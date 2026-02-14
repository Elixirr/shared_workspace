import "dotenv/config";
import express from "express";
import path from "node:path";
import { createCampaignHandler, getCampaignMetricsHandler } from "./command-handler";
import { callWebhookHandler } from "./webhooks-handler";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use("/demo", express.static(path.join(process.cwd(), "public", "demo")));

app.get("/", (_req, res) => {
  res.json({ status: "Pipeline running..." });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/campaigns", (req, res) => {
  void createCampaignHandler(req, res);
});

app.get("/campaigns/:id/metrics", (req, res) => {
  void getCampaignMetricsHandler(req, res);
});

app.post("/webhooks/calls/:provider", (req, res) => {
  void callWebhookHandler(req, res);
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
