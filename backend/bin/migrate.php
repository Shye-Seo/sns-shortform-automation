#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * Apply database/schema.sql to MySQL 8.0 and verify the result.
 *
 *   php backend/bin/migrate.php [--fresh] [--seed] [--verify]
 */

require __DIR__ . '/../vendor/autoload.php';

use Shortform\Database\Connection;
use Shortform\Support\Env;

Env::load(__DIR__ . '/../.env');

$options = getopt('', ['fresh', 'seed', 'verify', 'help', 'sql::']);

if (isset($options['help'])) {
    fwrite(STDOUT, "usage: php backend/bin/migrate.php [--fresh] [--seed] [--verify]\n");
    exit(0);
}

$schemaPath = $options['sql'] ?? __DIR__ . '/../../database/schema.sql';
if (!is_readable($schemaPath)) {
    fwrite(STDERR, "Schema not found: {$schemaPath}\n");
    exit(1);
}

$socket = Env::get('DB_UNIX_SOCKET');
$database = Env::get('DB_DATABASE', 'shortform') ?? 'shortform';
$serverDsn = $socket !== null
    ? "mysql:unix_socket={$socket};charset=utf8mb4"
    : sprintf('mysql:host=%s;port=%d;charset=utf8mb4', Env::get('DB_HOST', '127.0.0.1'), Env::int('DB_PORT', 3306));

$connection = Connection::fromDsn(
    $serverDsn,
    Env::get('DB_USERNAME', 'root') ?? 'root',
    Env::get('DB_PASSWORD', '') ?? '',
    Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00',
);
$pdo = $connection->pdo();

if (isset($options['fresh'])) {
    $pdo->exec("DROP DATABASE IF EXISTS `{$database}`");
    fwrite(STDOUT, "dropped database: {$database}\n");
}

/**
 * Split a SQL file into statements.
 *
 * Only valid because this schema contains no procedures/triggers and no semicolon inside
 * string literals. If that changes, this function must change with it.
 *
 * (Do not use \R here: in PCRE it also matches NEL 0x85, which appears inside Korean
 * UTF-8 sequences and would cut statements mid-character.)
 *
 * @return list<string>
 */
function splitStatements(string $sql): array
{
    $statements = [];
    $buffer = '';

    foreach (explode("\n", str_replace("\r\n", "\n", $sql)) as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '--') || str_starts_with($trimmed, '#')) {
            continue;
        }
        $buffer .= $line . "\n";
        if (str_ends_with($trimmed, ';')) {
            $statement = rtrim(trim($buffer), ';');
            if ($statement !== '') {
                $statements[] = $statement;
            }
            $buffer = '';
        }
    }

    return $buffer === '' ? $statements : [...$statements, trim($buffer)];
}

$statements = splitStatements((string) file_get_contents($schemaPath));
fwrite(STDOUT, sprintf("applying %s (%d statements)\n", basename($schemaPath), count($statements)));

$startedAt = microtime(true);
foreach ($statements as $index => $statement) {
    try {
        $pdo->exec($statement);
    } catch (\PDOException $e) {
        fwrite(STDERR, sprintf("failed at #%d: %s\n  %s\n", $index + 1, mb_substr($statement, 0, 160), $e->getMessage()));
        exit(1);
    }
}
fwrite(STDOUT, sprintf("applied in %.2fs\n", microtime(true) - $startedAt));

$pdo->exec("USE `{$database}`");

if (isset($options['seed'])) {
    $seedPath = __DIR__ . '/../../database/seed_demo.sql';
    if (is_readable($seedPath)) {
        foreach (splitStatements((string) file_get_contents($seedPath)) as $statement) {
            $pdo->exec($statement);
        }
        fwrite(STDOUT, "seeded: seed_demo.sql\n");
    }
}

$tables = $pdo->query('SHOW TABLES')->fetchAll(\PDO::FETCH_COLUMN);
$expected = ['tenants', 'creator_accounts', 'shortform_projects', 'render_jobs', 'publish_logs', 'hook_experiments', 'alimtalk_notifications'];
$missing = array_diff($expected, $tables);
fwrite(STDOUT, sprintf("\ntables (%d): %s\n", count($tables), implode(', ', $tables)));
if ($missing !== []) {
    fwrite(STDERR, 'missing tables: ' . implode(', ', $missing) . "\n");
    exit(1);
}

if (isset($options['verify'])) {
    foreach ($expected as $table) {
        $indexes = $pdo->query("SHOW INDEX FROM `{$table}`")->fetchAll();
        $keys = array_values(array_unique(array_column($indexes, 'Key_name')));
        $fks = $pdo->query(
            "SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{$table}' AND REFERENCED_TABLE_NAME IS NOT NULL"
        )->fetchAll();
        fwrite(STDOUT, sprintf(
            "  %-24s indexes=%s fks=%s\n",
            $table,
            implode('/', $keys),
            implode('/', array_map(static fn (array $fk): string => $fk['CONSTRAINT_NAME'] . '→' . $fk['REFERENCED_TABLE_NAME'], $fks)) ?: '-',
        ));
    }
}

fwrite(STDOUT, "\nschema ready.\n");
