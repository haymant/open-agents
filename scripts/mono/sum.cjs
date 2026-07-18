require("http")
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/n1") return res.end(JSON.stringify({ value: 1.1 }));
    if (req.url === "/n2") return res.end(JSON.stringify({ value: 2.1 }));
    res.end(JSON.stringify({ error: "not found" }));
  })
  .listen(3000);
