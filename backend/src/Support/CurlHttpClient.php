<?php

declare(strict_types=1);

namespace Shortform\Support;

final class CurlHttpClient implements HttpClient
{
    public function send(HttpRequest $request): HttpResponse
    {
        $handle = curl_init();
        $headerLines = [];

        $headers = [];
        foreach ($request->headers as $name => $value) {
            $headers[] = "{$name}: {$value}";
        }

        curl_setopt_array($handle, [
            CURLOPT_URL => $request->url,
            CURLOPT_CUSTOMREQUEST => strtoupper($request->method),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $request->timeoutSeconds,
            CURLOPT_CONNECTTIMEOUT => $request->connectTimeoutSeconds,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_HEADERFUNCTION => static function ($_, string $line) use (&$headerLines): int {
                $headerLines[] = trim($line);

                return strlen($line);
            },
        ]);

        if ($request->body !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $request->body);
        }

        $body = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        curl_close($handle);

        if ($body === false) {
            throw new \RuntimeException("HTTP {$request->method} {$request->url} failed: {$error}");
        }

        $responseHeaders = [];
        foreach ($headerLines as $line) {
            if (str_starts_with($line, 'HTTP/') || !str_contains($line, ':')) {
                continue;
            }
            [$name, $value] = explode(':', $line, 2);
            $responseHeaders[strtolower(trim($name))] = trim($value);
        }

        return new HttpResponse($status, (string) $body, $responseHeaders, $request->url);
    }
}
