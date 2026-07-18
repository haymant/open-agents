require("http")
  .createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    require("fs").createReadStream("/workspace/sum.html").pipe(res);
  })
  .listen(3000);
