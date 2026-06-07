const https = require("https");

// Helper: make HTTPS request
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw.toString()), raw });
        } catch {
          resolve({ status: res.statusCode, body: raw.toString(), raw });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const PUBLIC_KEY = process.env.ILOVEPDF_PUBLIC_KEY;
  const SECRET_KEY = process.env.ILOVEPDF_SECRET_KEY;

  if (!PUBLIC_KEY || !SECRET_KEY) {
    return res.status(500).json({ error: "API keys not configured" });
  }

  try {
    const { fileBase64, fileName } = req.body;

    if (!fileBase64 || !fileName) {
      return res.status(400).json({ error: "Missing file data" });
    }

    // Step 1 — Authenticate with ilovepdf
    const authRes = await request(
      {
        hostname: "api.ilovepdf.com",
        path: "/v1/auth",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      JSON.stringify({ public_key: PUBLIC_KEY })
    );

    const token = authRes.body.token;
    if (!token) return res.status(500).json({ error: "Auth failed" });

    // Step 2 — Start task
    const taskRes = await request({
      hostname: "api.ilovepdf.com",
      path: "/v1/start/pdfoffice",
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const { server, task } = taskRes.body;
    if (!task) return res.status(500).json({ error: "Task creation failed" });

    // Step 3 — Upload file
    const fileBuffer = Buffer.from(fileBase64, "base64");
    const boundary = "----FormBoundary" + Date.now();
    const CRLF = "\r\n";

    const formParts = [
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="task"${CRLF}${CRLF}`,
      `${task}${CRLF}`,
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}`,
      `Content-Type: application/pdf${CRLF}${CRLF}`,
    ];

    const formEnd = `${CRLF}--${boundary}--${CRLF}`;
    const formHeader = Buffer.from(formParts.join(""));
    const formFooter = Buffer.from(formEnd);
    const formBody = Buffer.concat([formHeader, fileBuffer, formFooter]);

    const uploadRes = await request(
      {
        hostname: server,
        path: "/v1/upload",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": formBody.length,
        },
      },
      formBody
    );

    const serverFilename = uploadRes.body.server_filename;
    if (!serverFilename) return res.status(500).json({ error: "Upload failed" });

    // Step 4 — Process
    const processRes = await request(
      {
        hostname: server,
        path: "/v1/process",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      JSON.stringify({
        task,
        tool: "pdfoffice",
        files: [{ server_filename: serverFilename, filename: fileName }],
        outputformat: "docx",
      })
    );

    if (processRes.status !== 200) return res.status(500).json({ error: "Processing failed" });

    // Step 5 — Download
    const downloadRes = await request({
      hostname: server,
      path: `/v1/download/${task}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    // Return as base64
    const resultBase64 = downloadRes.raw.toString("base64");
    const outName = fileName.replace(/\.pdf$/i, ".docx");

    return res.status(200).json({ fileBase64: resultBase64, fileName: outName });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Conversion failed: " + err.message });
  }
};
