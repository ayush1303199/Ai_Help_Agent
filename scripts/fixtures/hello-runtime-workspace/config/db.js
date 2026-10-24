'use strict';

module.exports = {
  databaseUrl: process.env.DATABASE_URL || null,
  port: Number(process.env.PORT) || 5000,
};
