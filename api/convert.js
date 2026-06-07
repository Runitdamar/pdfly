const https = require("https");

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

    // Step 1 — Auth (iLoveAPI new endpoint)
    const authRes = await request(
      {
        hostname: "api.ilovepdf.com",
        path: "/v1/auth",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(JSON.stringify({ public_key: PUBLIC_KEY })) },
      },
      JSON.stringify({ public_key: PUBLIC_KEY })
    );

    console.log("Auth response:", JSON.stringify(authRes.body));
    const token = authRes.body.token;
    if (!token) return res.status(500).json({ error: "Auth failed: " + JSON.stringify(authRes.body) });

    // Step 2 — Start task
    const taskRes = await request({
      hostname: "api.ilovepdf.com",
      path: "/v1/start/pdfoffice",
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("Task response:", JSON.stringify(taskRes.body));
    const { server, task } = taskRes.body;
    if (!task) return res.status(500).json({ error: "Task failed: " + JSON.stringify(taskRes.body) });

    // Step 3 — Upload
    const fileBuffer = Buffer.from(fileBase64, "base64");
    const boundary = "----FormBoundary" + Date.now();
    const CRLF = "\r\n";
    const formHeader = Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="task"${CRLF}${CRLF}${task}${CRLF}` +
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: application/pdf${CRLF}${CRLF}`
    );
    const formFooter = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
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

    console.log("Upload response:", JSON.stringify(uploadRes.body));
    const serverFilename = uploadRes.body.server_filename;
    if (!serverFilename) return res.status(500).json({ error: "Upload failed: " + JSON.stringify(uploadRes.body) });

    // Step 4 — Process
    const processBody = JSON.stringify({
      task,
      tool: "pdfoffice",
      files: [{ server_filename: serverFilename, filename: fileName }],
      outputformat: "docx",
    });

    const processRes = await request(
      {
        hostname: server,
        path: "/v1/process",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(processBody),
        },
      },
      processBody
    );

    console.log("Process response:", JSON.stringify(processRes.body));
    if (processRes.status !== 200) {
      return res.status(500).json({ error: "Process failed: " + JSON.stringify(processRes.body) });
    }

    // Step 5 — Download
    const downloadRes = await request({
      hostname: server,
      path: `/v1/download/${task}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const resultBase64 = downloadRes.raw.toString("base64");
    const outName = fileName.replace(/\.pdf$/i, ".docx");

    return res.status(200).json({ fileBase64: resultBase64, fileName: outName });

  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Conversion failed: " + err.message });
  }
};
        
