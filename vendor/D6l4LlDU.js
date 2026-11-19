export const bw = (fn) => fn();
export const a = () => ({ public: { clientEncryptDecrypt: "true", cpid: "asik_web" } });
export const u = (name) => ({ value: process.env[name.toUpperCase().replace(/-/g,"_")] ?? process.env[name] ?? "" });
export const bx = JSON.parse;
