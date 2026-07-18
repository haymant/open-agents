require("http")
  .createServer((r, s) => s.end("Hello World"))
  .listen(3000);
