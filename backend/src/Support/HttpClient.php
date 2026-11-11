<?php

declare(strict_types=1);

namespace Shortform\Support;

/**
 * HTTP boundary.
 *
 * Every external call (Meta Graph, NCP SENS) goes through this interface so tests can
 * assert on the exact request that would have been sent — form fields, headers, signature —
 * and so a provider outage is a stub, not a real charge or a real publish.
 */
interface HttpClient
{
    public function send(HttpRequest $request): HttpResponse;
}
