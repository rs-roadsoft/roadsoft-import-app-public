/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema.createTable('settings', (table) => {
    table.increments();
    table.string('name');
    table.string('value');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.hasTable('settings').then((exists) => {
    if (exists) {
      return knex.schema.dropTable('settings');
    }
  });
};
