import type { DiscoveryCandidate, DiscoveryProvider } from "./types";

export const chosicDiscoveryProvider: DiscoveryProvider = {
  name: "chosic",
  enabled: process.env.CHOSIC_DISCOVERY_ENABLED === "true",
  async findSimilarSongs(): Promise<DiscoveryCandidate[]> {
    // Chosic does not provide a stable public API for this app yet. Keep this
    // adapter as an explicit extension point and avoid brittle scraping.
    return [];
  }
};
