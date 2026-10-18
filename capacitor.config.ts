import tailwindcss from "@tailwindcss/vite";
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.shounak.studydesk",
  appName: "StudyDesk",
  webDir: "dist",
  server: { cleartext: true },
  android: { allowMixedContent: true },
};

export default config;
