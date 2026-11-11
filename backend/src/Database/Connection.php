<?php

declare(strict_types=1);

namespace Shortform\Database;

use Shortform\Support\Env;

/**
 * PDO connection (MySQL 8.0).
 *
 * - ERRORMODE_EXCEPTION: a silent false would let a worker "complete" a job it never wrote.
 * - EMULATE_PREPARES=false: server-side prepares keep the plan cache useful under load and
 *   preserve integer types (the queue compares `priority`/`available_at` a lot).
 * - Session time_zone is pinned: settlement of "today" must not slip a day because the
 *   server default is UTC.
 * - Version check at connect time: 8.0.19+ is required for `AS new` upsert aliases and
 *   `FOR UPDATE SKIP LOCKED` semantics used by the queue.
 */
final class Connection
{
    private function __construct(private readonly \PDO $pdo)
    {
    }

    public static function fromEnv(): self
    {
        $socket = Env::get('DB_UNIX_SOCKET');
        $database = Env::get('DB_DATABASE', 'shortform') ?? 'shortform';

        $dsn = $socket !== null
            ? "mysql:unix_socket={$socket};dbname={$database};charset=utf8mb4"
            : sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                Env::get('DB_HOST', '127.0.0.1'),
                Env::int('DB_PORT', 3306),
                $database,
            );

        return self::fromDsn(
            $dsn,
            Env::get('DB_USERNAME', 'root') ?? 'root',
            Env::get('DB_PASSWORD', '') ?? '',
            Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00',
        );
    }

    public static function fromDsn(string $dsn, string $user, string $password, string $timezone = '+09:00'): self
    {
        $pdo = new \PDO($dsn, $user, $password, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES => false,
            \PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);

        $version = (string) $pdo->query('SELECT VERSION()')->fetchColumn();
        if (version_compare(preg_replace('/[^0-9.].*$/', '', $version) ?: '0', '8.0.19', '<')) {
            throw new \RuntimeException("MySQL 8.0.19+ required (found {$version}).");
        }

        $pdo->exec("SET time_zone = '{$timezone}'");
        $pdo->exec("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'");

        return new self($pdo);
    }

    public function pdo(): \PDO
    {
        return $this->pdo;
    }

    /**
     * Run a transaction, retrying deadlocks (1213) and lock-wait timeouts (1205).
     * A render batch touches the same jobs table from several workers; retrying twice is
     * the difference between "the queue survived" and "the queue failed because of a race".
     *
     * @template T
     * @param callable(\PDO):T $work
     * @return T
     */
    public function transaction(callable $work, int $maxAttempts = 3): mixed
    {
        $attempt = 0;
        attempt:
        $attempt++;

        $this->pdo->beginTransaction();
        try {
            $result = $work($this->pdo);
            $this->pdo->commit();

            return $result;
        } catch (\PDOException $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            if (in_array((int) ($e->errorInfo[1] ?? 0), [1205, 1213], true) && $attempt < $maxAttempts) {
                usleep(50_000 * $attempt);
                goto attempt;
            }
            throw $e;
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e;
        }
    }
}
