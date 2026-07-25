"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = void 0;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
const fs = __importStar(require("node:fs"));
const paths_1 = require("./paths");
const DEFAULTS = {
    loopThreshold: 3,
    holdTransport: "auto",
};
exports.DEFAULT_CONFIG = DEFAULTS;
function loadConfig(payloadCwd) {
    try {
        const raw = fs.readFileSync((0, paths_1.configPath)(payloadCwd), "utf8");
        const parsed = JSON.parse(raw);
        return { ...DEFAULTS, ...parsed };
    }
    catch {
        return { ...DEFAULTS };
    }
}
function saveConfig(config, payloadCwd) {
    fs.writeFileSync((0, paths_1.configPath)(payloadCwd), JSON.stringify(config, null, 2) + "\n");
}
