export const c = (shape) => ({ isValid: (obj) => !!obj && typeof obj.csk === "string" && typeof obj.spk === "string" });
export const a = () => ({ required: () => ({}) });
