import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

const models = [
    'fal-ai/flux/schnell',
    'fal-ai/flux/dev',
    'fal-ai/flux-pro/v1.1',
    'fal-ai/flux-pro/v2',
    'fal-ai/recraft-v3',
    'fal-ai/flux-kontext/pro',
    'fal-ai/seedream/v4.5',
    'fal-ai/kling-video/v3/pro/text-to-video',
    'fal-ai/veo2/text-to-video',
    'fal-ai/sora',
    'fal-ai/kling-video/v3/pro/image-to-video',
    'fal-ai/veo2/image-to-video'
];

async function checkSchema() {
    for (const model of models) {
        try {
            const res = await fetch(`https://fal.run/${model}/openapi.json`, {
                headers: { 'Authorization': `Key ${process.env.FAL_KEY}` }
            });
            if (res.ok) {
                const schema = await res.json();
                const outputProps = schema.components?.schemas?.Output?.properties;
                const inputProps = schema.components?.schemas?.Input?.properties;
                console.log(`\n================ ${model} ================`);
                console.log(`INPUTS:`, Object.keys(inputProps || {}).join(', '));
                console.log(`OUTPUTS:`, Object.keys(outputProps || {}).join(', '));
            } else {
                console.log(`\nFailed for ${model}: ${res.status}`);
            }
        } catch (e) {
            console.log(`\nError for ${model}: ${e.message}`);
        }
    }
}

checkSchema();
