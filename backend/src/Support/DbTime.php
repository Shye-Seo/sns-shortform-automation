<?php

declare(strict_types=1);

namespace Shortform\Support;

/**
 * MySQL DATETIME(3) ↔ DateTimeImmutable.
 *
 * The connection pins the session time zone (`SET time_zone = '+09:00'`), so a DATETIME
 * string coming back has no offset and means Korea time. Constructing it with the PHP
 * process default (often UTC in a container) silently shifts every campaign window by
 * nine hours — a campaign that ended at 23:59 would still look live the next morning.
 *
 * Writes go through `format()` so the same zone is used in both directions.
 */
final class DbTime
{
    private static ?\DateTimeZone $zone = null;

    public static function zone(): \DateTimeZone
    {
        return self::$zone ??= new \DateTimeZone(Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00');
    }

    /** Reset cached zone (tests that change DB_TIMEZONE). */
    public static function reset(): void
    {
        self::$zone = null;
    }

    public static function parse(?string $value): ?\DateTimeImmutable
    {
        if ($value === null || trim($value) === '') {
            return null;
        }

        return new \DateTimeImmutable($value, self::zone());
    }

    public static function format(\DateTimeImmutable $at): string
    {
        return $at->setTimezone(self::zone())->format('Y-m-d H:i:s.v');
    }

    /** `now()` in the database session zone — for DEFAULT-less INSERTs that use SQL NOW(). */
    public static function now(): string
    {
        return (new \DateTimeImmutable('now', self::zone()))->format('Y-m-d H:i:s.v');
    }
}
