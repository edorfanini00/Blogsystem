<?php
/**
 * Expose Yoast SEO meta fields to the WordPress REST API.
 *
 * Upload this file to: wp-content/mu-plugins/expose-yoast-rest.php
 *
 * This lets the blog system auto-fill the Yoast focus keyphrase,
 * SEO title, and meta description on every publish — no manual entry needed.
 *
 * Only needs to be uploaded ONCE. Works automatically for every post after that.
 */
add_action('init', function () {
    $fields = [
        '_yoast_wpseo_focuskw',   // Focus keyphrase
        '_yoast_wpseo_title',     // SEO title
        '_yoast_wpseo_metadesc',  // Meta description
    ];

    foreach ($fields as $key) {
        register_post_meta('post', $key, [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function () {
                return current_user_can('edit_posts');
            },
        ]);
    }
});
