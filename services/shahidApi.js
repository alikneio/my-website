// services/shahidApi.js
const axios = require("axios");

const shahid = axios.create({
  baseURL: process.env.SHAHID_BASE_URL,
  headers: {
    "x-api-key": process.env.SHAHID_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

module.exports = {
  getTypes: async () => (await shahid.get("/api/v1/shahid/types")).data,
  buy: async (payload) => (await shahid.post("/api/v1/shahid/buy", payload)).data,
  getById: async (id) => (await shahid.get(`/api/v1/shahid/subscription/${encodeURIComponent(id)}`)).data,
};
