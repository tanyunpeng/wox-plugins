// Prints only the length of the env value; never its contents.
const v = process.env.BW_TEST_PASSWORD || "";
console.log(`node sees BW_TEST_PASSWORD length=${v.length} expected=${process.argv[2] || "?"} match=${v.length === Number(process.argv[2])}`);
