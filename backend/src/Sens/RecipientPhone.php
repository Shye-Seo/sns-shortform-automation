<?php

declare(strict_types=1);

namespace Shortform\Sens;

/**
 * Korean mobile number normalised to SENS' required form.
 * SENS only accepts digits, while operators type "010-1234-5678" and stored chat ids
 * sometimes carry +82. Normalising in one place prevents the classic
 * "9008 invalid phone" that only shows up in production for one recipient.
 */
final readonly class RecipientPhone
{
    private function __construct(
        public string $digits,
        public string $countryCode,
    ) {
    }

    public static function fromString(string $raw): self
    {
        $digits = preg_replace('/\D+/', '', $raw) ?? '';

        if (str_starts_with($digits, '82') && strlen($digits) === 12) {
            $digits = '0' . substr($digits, 2);
        } elseif (str_starts_with($digits, '0082')) {
            $digits = '0' . substr($digits, 4);
        }

        if (preg_match('/^01[016789][0-9]{7,8}$/', $digits) !== 1) {
            throw new \InvalidArgumentException("Not a Korean mobile number: {$raw}");
        }

        return new self($digits, '82');
    }

    public function masked(): string
    {
        return substr($this->digits, 0, 3) . '-****-' . substr($this->digits, -4);
    }
}
