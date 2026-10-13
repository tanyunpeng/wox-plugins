// Hidden stdin prompt for a password: no echo, no argv, no file.
// Returns envValue immediately when present (non-interactive use).
module.exports = function readHidden(envValue) {
  if (envValue) return Promise.resolve(envValue);
  if (!process.stdin.isTTY) {
    console.error("no interactive terminal: run this in Git Bash, or set BW_TEST_PASSWORD");
    process.exit(2);
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    // Collect raw bytes. Iterating a decoded string byte-by-byte would corrupt
    // any non-ASCII character typed through the console.
    const bytes = [];
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(new TextDecoder("utf8").decode(Buffer.concat(bytes)));
    };
    function onData(chunk) {
      for (const code of chunk) {
        if (code === 13 || code === 10) return finish();
        if (code === 3) {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          return process.exit(130);
        }
        if (code === 127 || code === 8) bytes.pop();
        else if (code >= 32) bytes.push(Buffer.from([code]));
      }
    }
    // Git Bash runs on an MSYS pty; if raw mode is unavailable there we fail
    // loudly instead of echoing the password or hanging.
    try {
      process.stdout.write("master password: ");
      stdin.setRawMode(true);
      stdin.setEncoding("utf8");
      stdin.resume();
      stdin.on("data", onData);
    } catch (e) {
      try {
        stdin.setRawMode(false);
      } catch { /* already restored */ }
      console.error(
        `hidden input unavailable here (${e.message}). Run in PowerShell instead:\n` +
          '  $s = Read-Host "master password" -AsSecureString\n' +
          "  $env:BW_TEST_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringUni(" +
          "[Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($s))\n" +
          "  node spike/gate2.js https://vault.bitwarden.com you@example.com\n" +
          "  Remove-Item Env:BW_TEST_PASSWORD",
      );
      process.exit(3);
    }
  });
};
