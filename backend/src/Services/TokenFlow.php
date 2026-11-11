<?php

declare(strict_types=1);

namespace Shortform\Services;

/** Which long-lived token family we are refreshing. */
enum TokenFlow: string
{
    /** Facebook Login derived tokens (graph.facebook.com/oauth/access_token). */
    case FacebookExchange = 'fb_exchange_token';

    /** Instagram API with Instagram Login tokens (graph.instagram.com/refresh_access_token). */
    case InstagramRefresh = 'ig_refresh_token';
}
