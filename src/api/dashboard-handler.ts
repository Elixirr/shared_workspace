import { Request, Response } from "express";

const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pipeline Dashboard</title>
    <style>
      :root {
        --bg: #f4f7fb;
        --ink: #152033;
        --muted: #52627c;
        --brand: #145c95;
        --line: #d4dfec;
        --card: #ffffff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: var(--bg);
        color: var(--ink);
      }
      .wrap {
        width: min(1100px, 100% - 32px);
        margin: 24px auto 48px;
        display: grid;
        gap: 16px;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 16px;
      }
      h1, h2 { margin: 0 0 12px; }
      h1 { font-size: 28px; }
      h2 { font-size: 20px; }
      .row {
        display: grid;
        gap: 8px;
      }
      .grid3 {
        display: grid;
        gap: 8px;
      }
      label {
        font-size: 14px;
        color: var(--muted);
      }
      input {
        width: 100%;
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 16px;
      }
      button {
        min-height: 44px;
        border: 1px solid var(--brand);
        background: var(--brand);
        color: #fff;
        border-radius: 8px;
        padding: 10px 14px;
        cursor: pointer;
      }
      button.secondary {
        background: #fff;
        color: var(--brand);
      }
      button:hover { filter: brightness(0.96); }
      .status {
        font-size: 14px;
        color: var(--muted);
      }
      .lines {
        display: grid;
        gap: 6px;
      }
      .line {
        font-size: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 10px 8px;
        border-bottom: 1px solid var(--line);
        font-size: 14px;
      }
      td .link {
        color: var(--brand);
        text-decoration: none;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      @media (min-width: 768px) {
        .grid3 {
          grid-template-columns: 1fr 1fr 1fr auto;
          align-items: end;
        }
        .grid2 {
          grid-template-columns: 1fr;
          align-items: end;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="card">
        <h1>Demo Pipeline Dashboard</h1>
        <div class="grid3">
          <div class="row">
            <label for="niche">Niche</label>
            <input id="niche" value="roofers" />
          </div>
          <div class="row">
            <label for="city">City</label>
            <input id="city" value="Dallas" />
          </div>
          <div class="row">
            <label for="limit">Limit</label>
            <input id="limit" type="number" value="5" min="1" max="100" />
          </div>
          <button id="createCampaign">Create Campaign</button>
        </div>
        <div class="grid2" style="margin-top: 8px;">
          <div class="row">
            <label for="sheetDataUrl">Google Sheet JSON URL (optional)</label>
            <input id="sheetDataUrl" placeholder="https://script.google.com/macros/s/.../exec" />
          </div>
        </div>
        <div class="grid2" style="margin-top: 8px;">
          <div class="row">
            <label for="manualBusinessName">Manual Business Name (fallback)</label>
            <input id="manualBusinessName" value="Kirn Construction" />
          </div>
          <div class="row">
            <label for="manualWebsiteUrl">Manual Website URL (fallback)</label>
            <input id="manualWebsiteUrl" value="https://www.kirnconstruction.com/" />
          </div>
        </div>
        <div class="actions" style="margin-top: 12px;">
          <button class="secondary" id="searchOneLead">Search 1 Lead + Build Demo</button>
          <button class="secondary" id="manualOneLead">Use Manual Site URL</button>
        </div>
        <p class="status" id="campaignStatus">No campaign selected.</p>
      </section>

      <section class="card">
        <div class="actions">
          <button class="secondary" id="refreshData">Refresh</button>
          <button class="secondary" id="openFirstDemo">Open First Demo</button>
        </div>
        <div class="lines">
          <div class="line" id="line1">Found 0 leads</div>
          <div class="line" id="line2">0 live · 0 emailed · 0 called</div>
          <div class="line" id="line3">0 interested · 0 booked</div>
        </div>
      </section>

      <section class="card">
        <h2>Leads</h2>
        <table>
          <thead>
            <tr>
              <th>Business</th>
              <th>Status</th>
              <th>Demo</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="leadsBody"></tbody>
        </table>
      </section>

      <section class="card">
        <h2>Sales Playbook (Google Sheet Editing)</h2>
        <p class="status">Use this script in outreach calls and demo videos.</p>
        <div class="row" style="gap: 12px;">
          <p><strong>Not clickbait. Here's how it works.</strong></p>
          <p>Selling AI websites to local businesses. The method works. But kept losing sales to one objection: "What if I need to change something? I don't know how to edit websites."</p>
          <p>Connect the website to a Google Sheet. They open a spreadsheet. Change their hours, prices, services, images. Site updates automatically.</p>
          <p><strong>The Full Method</strong></p>
          <ol>
            <li>Find prospects: Google Maps → "plumber [city]" → businesses with bad/no websites</li>
            <li>Build site in AI tools in minutes</li>
            <li>Connect to Google Sheet tabs: Business Info, Services, About, Testimonials</li>
            <li>Record 30-second demo: edit sheet, refresh site, show update</li>
            <li>Send email with MP4 attached (not a link)</li>
          </ol>
          <p><strong>Apps Script snippet:</strong></p>
          <pre style="white-space: pre-wrap; background: #f8fbff; border: 1px solid #d4dfec; border-radius: 10px; padding: 12px; overflow: auto; max-height: 300px;">function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const businessInfo = ss.getSheetByName('Business Info').getDataRange().getValues();
  const services = ss.getSheetByName('Services').getDataRange().getValues();
  const about = ss.getSheetByName('About').getDataRange().getValues();
  const testimonials = ss.getSheetByName('Testimonials').getDataRange().getValues();
  const data = {
    business: rowsToObject(businessInfo),
    services: rowsToArray(services),
    about: rowsToObject(about),
    testimonials: rowsToArray(testimonials)
  };
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function rowsToObject(rows) {
  const obj = {};
  rows.slice(1).forEach(row => { obj[row[0]] = row[1]; });
  return obj;
}

function rowsToArray(rows) {
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((header, i) => { obj[header] = row[i]; });
    return obj;
  });
}</pre>
          <p><strong>Pricing:</strong> $500–$1000 one-time. Best niches: dentists, plumbers, car detailers, cleaners, landscapers, personal trainers.</p>
        </div>
      </section>
    </div>

    <script>
      const state = { campaignId: null, leads: [] };
      const AUTO_REFRESH_MS = 5000;
      let refreshTimer = null;

      const el = {
        niche: document.getElementById("niche"),
        city: document.getElementById("city"),
        limit: document.getElementById("limit"),
        sheetDataUrl: document.getElementById("sheetDataUrl"),
        manualBusinessName: document.getElementById("manualBusinessName"),
        manualWebsiteUrl: document.getElementById("manualWebsiteUrl"),
        createCampaign: document.getElementById("createCampaign"),
        searchOneLead: document.getElementById("searchOneLead"),
        manualOneLead: document.getElementById("manualOneLead"),
        refreshData: document.getElementById("refreshData"),
        openFirstDemo: document.getElementById("openFirstDemo"),
        campaignStatus: document.getElementById("campaignStatus"),
        line1: document.getElementById("line1"),
        line2: document.getElementById("line2"),
        line3: document.getElementById("line3"),
        leadsBody: document.getElementById("leadsBody")
      };

      const setStatus = (message) => {
        el.campaignStatus.textContent = message;
      };

      const openInNewTab = (url) => {
        const target = "_blank_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        window.open(url, target, "noopener,noreferrer");
      };

      const renderLeads = () => {
        const rows = state.leads.map((lead) => {
          const demoCell = lead.demoUrl
            ? '<button data-open-demo="' + lead.demoUrl + '" class="secondary">Open</button>'
            : "-";
          return '<tr>' +
            '<td>' + (lead.businessName || "Unknown") + '</td>' +
            '<td>' + lead.status + '</td>' +
            '<td>' + demoCell + '</td>' +
            '<td><button data-regenerate="' + lead.id + '" class="secondary">Regenerate</button></td>' +
          '</tr>';
        }).join("");
        el.leadsBody.innerHTML = rows;
      };

      const loadMetrics = async () => {
        if (!state.campaignId) return;
        const res = await fetch('/campaigns/' + state.campaignId + '/metrics');
        if (!res.ok) return;
        const metrics = await res.json();
        el.line1.textContent = metrics.line1;
        el.line2.textContent = metrics.line2;
        el.line3.textContent = metrics.line3;
      };

      const loadLeads = async () => {
        if (!state.campaignId) return;
        const res = await fetch('/campaigns/' + state.campaignId + '/leads');
        if (!res.ok) return;
        const payload = await res.json();
        state.leads = payload.leads;
        renderLeads();
      };

      const refreshAll = async () => {
        await Promise.all([loadMetrics(), loadLeads()]);
      };

      const startAutoRefresh = () => {
        if (refreshTimer !== null) return;
        refreshTimer = window.setInterval(() => {
          if (!state.campaignId || document.hidden) return;
          void refreshAll();
        }, AUTO_REFRESH_MS);
      };

      const stopAutoRefresh = () => {
        if (refreshTimer === null) return;
        window.clearInterval(refreshTimer);
        refreshTimer = null;
      };

      el.createCampaign.addEventListener("click", async () => {
        const niche = el.niche.value.trim();
        const city = el.city.value.trim();
        const limit = Number(el.limit.value);
        const sheetDataUrl = el.sheetDataUrl.value.trim();
        setStatus("Creating campaign...");
        const res = await fetch("/campaigns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ niche, city, limit, sheetDataUrl: sheetDataUrl || undefined })
        });
        const payload = await res.json();
        if (!res.ok) {
          setStatus("Error: " + (payload.error || "Failed to create campaign"));
          return;
        }
        state.campaignId = payload.campaignId;
        setStatus("Campaign: " + state.campaignId + " · Auto-refresh every 5s");
        await refreshAll();
        startAutoRefresh();
      });

      el.searchOneLead.addEventListener("click", async () => {
        const niche = el.niche.value.trim();
        const city = el.city.value.trim();
        const sheetDataUrl = el.sheetDataUrl.value.trim();
        setStatus("Searching one real lead...");
        const res = await fetch("/campaigns/search-one", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ niche, city, sheetDataUrl: sheetDataUrl || undefined })
        });
        const payload = await res.json();
        if (!res.ok) {
          setStatus("Error: " + (payload.error || "Search failed"));
          return;
        }
        state.campaignId = payload.campaignId;
        setStatus("Campaign: " + state.campaignId + " · 1 lead found: " + payload.businessName);
        await refreshAll();
        startAutoRefresh();
      });

      el.manualOneLead.addEventListener("click", async () => {
        const niche = el.niche.value.trim();
        const city = el.city.value.trim();
        const sheetDataUrl = el.sheetDataUrl.value.trim();
        const businessName = el.manualBusinessName.value.trim();
        const websiteUrl = el.manualWebsiteUrl.value.trim();
        if (!businessName || !websiteUrl) {
          setStatus("Enter manual business name + website URL first.");
          return;
        }
        setStatus("Creating one manual lead...");
        const res = await fetch("/campaigns/manual-one", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            niche,
            city,
            businessName,
            websiteUrl,
            sheetDataUrl: sheetDataUrl || undefined
          })
        });
        const payload = await res.json();
        if (!res.ok) {
          setStatus("Error: " + (payload.error || "Manual lead failed"));
          return;
        }
        state.campaignId = payload.campaignId;
        setStatus("Campaign: " + state.campaignId + " · manual lead added");
        await refreshAll();
        startAutoRefresh();
      });

      el.refreshData.addEventListener("click", async () => {
        setStatus(state.campaignId ? "Refreshing..." : "No campaign selected.");
        await refreshAll();
      });

      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          stopAutoRefresh();
          return;
        }
        if (state.campaignId) {
          void refreshAll();
          startAutoRefresh();
        }
      });

      el.openFirstDemo.addEventListener("click", () => {
        const first = state.leads.find((lead) => typeof lead.demoUrl === "string" && lead.demoUrl.length > 0);
        if (!first) {
          setStatus("No demo URL ready yet.");
          return;
        }
        openInNewTab(first.demoUrl);
      });

      el.leadsBody.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const demoUrl = target.getAttribute("data-open-demo");
        if (demoUrl) {
          openInNewTab(demoUrl);
          return;
        }
        const leadId = target.getAttribute("data-regenerate");
        if (!leadId) return;
        target.setAttribute("disabled", "true");
        await fetch("/leads/" + leadId + "/regenerate", { method: "POST" });
        await refreshAll();
      });

      startAutoRefresh();
    </script>
  </body>
</html>`;

export const dashboardHandler = (_req: Request, res: Response): void => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(dashboardHtml);
};
