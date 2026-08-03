export default {
  async fetch() {
    return Response.json({ worker: "effects", role: "credential broker" });
  },
};
