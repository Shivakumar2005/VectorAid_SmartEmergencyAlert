// Ambulances use blues and violets only: red, yellow and green belong to the signal lamps.
export const BEACON = "#1F4FD8";
export const AMB_PALETTE = ["#1F4FD8", "#7B2FD0", "#0E7C8C", "#B0307F", "#3D5A80"];
export const ambColor = (num: number) => AMB_PALETTE[(((num - 101) % AMB_PALETTE.length) + AMB_PALETTE.length) % AMB_PALETTE.length];
export const LAMP_HEX = { R: "#E0372B", Y: "#F0A500", G: "#14A05D" } as const;
export const TURN_CODE = { NONE: 0, STRAIGHT: 1, LEFT: 2, RIGHT: 3, U_TURN: 4 } as const;
