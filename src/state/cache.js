// Simple in-memory cache. Safe to lose on restart.
export const eventCache = new Map(); // eventId -> { title, description, image_url, unix }
