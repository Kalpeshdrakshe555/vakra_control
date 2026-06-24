export interface DesignSemantics {
    industry: string;
    audience: string;
    emotion: string;
    palette_mood: 'dark' | 'light';
    sections: string[];
    layout: string;
    typography_feel: string;
    custom_colors?: { primary: string; accent: string; surface: string };
    custom_font?: string;
    corner_style?: string; // e.g., 'sharp', 'rounded', 'pill'
}

export interface BrandDNA {
    palette: { primary: string; accent: string; surface: string };
    fontPair: { display: string; body: string };
    logoSVG: string;
    spacing: string;
    borderRadius: string;
    cssVars: string;
}

const INDUSTRY_PALETTES: Record<string, any> = {
    fitness: {
        dark: { primary: "#0A0A0A", accent: "#00FF87", surface: "#111111" },
        light: { primary: "#FFFFFF", accent: "#FF3B3B", surface: "#F5F5F5" }
    },
    fintech: {
        dark: { primary: "#0D1117", accent: "#4F8EF7", surface: "#161B22" },
        light: { primary: "#FAFBFC", accent: "#0066CC", surface: "#F0F4F8" }
    },
    healthcare: {
        dark: { primary: "#0F172A", accent: "#10B981", surface: "#1E293B" },
        light: { primary: "#FFFFFF", accent: "#059669", surface: "#F8FAFC" }
    },
    saas: {
        dark: { primary: "#111827", accent: "#8B5CF6", surface: "#1F2937" },
        light: { primary: "#FFFFFF", accent: "#6D28D9", surface: "#F3F4F6" }
    },
    ecommerce: {
        dark: { primary: "#000000", accent: "#F97316", surface: "#171717" },
        light: { primary: "#FFFFFF", accent: "#EA580C", surface: "#FAFAFA" }
    },
    education: {
        dark: { primary: "#1E1E2F", accent: "#FBBF24", surface: "#2A2A3C" },
        light: { primary: "#FFFFFF", accent: "#D97706", surface: "#F4F4F9" }
    },
    crypto: {
        dark: { primary: "#0B0E14", accent: "#00FFC2", surface: "#151A22" },
        light: { primary: "#FFFFFF", accent: "#3B82F6", surface: "#F0F3F8" }
    },
    food: {
        dark: { primary: "#2A0800", accent: "#FF4500", surface: "#3D1408" },
        light: { primary: "#FFF5F0", accent: "#E11D48", surface: "#FFFFFF" }
    },
    default: {
        dark: { primary: "#121212", accent: "#3B82F6", surface: "#1E1E1E" },
        light: { primary: "#FFFFFF", accent: "#2563EB", surface: "#F3F4F6" }
    }
};

const FONT_PAIRS: Record<string, { display: string; body: string }> = {
    "bold": { display: "Space Grotesk", body: "Inter" },
    "elegant": { display: "Playfair Display", body: "Lora" },
    "modern": { display: "Outfit", body: "Roboto" },
    "friendly": { display: "Quicksand", body: "Nunito" },
    "default": { display: "Inter", body: "Inter" }
};

const SPACING = {
    "full-width landing": "loose",
    "dashboard": "compact",
    "default": "moderate"
};

const BORDER_RADII: Record<string, string> = {
    "sharp": "0.25rem",   // 4px
    "rounded": "0.75rem", // 12px
    "pill": "9999px",
    "default": "0.75rem"
};

function generateLogoSVG(industry: string, palette: { primary: string; accent: string; surface: string }): string {
    // Generate more professional, complex, and aesthetically pleasing vector logos with dual-color gradients.
    const gradId = `grad-${industry}`;
    const linearGradient = `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:${palette.accent};stop-opacity:1" /><stop offset="100%" style="stop-color:${palette.primary};stop-opacity:0.8" /></linearGradient></defs>`;

    if (industry === 'fitness') { // Stylized heartbeat/flame
        return `<svg viewBox="0 0 100 100" width="40" height="40" xmlns="http://www.w3.org/2000/svg">${linearGradient}<path d="M10 50 L30 50 L40 30 L60 70 L70 50 L90 50" stroke="url(#${gradId})" stroke-width="8" fill="none" stroke-linecap="round"/></svg>`;
    } else if (industry === 'fintech') { // Abstract 'F' with a chart element
        return `<svg viewBox="0 0 100 100" width="40" height="40" xmlns="http://www.w3.org/2000/svg">${linearGradient}<path d="M25 20 H75 V35 H45 V80 H30 V35 H25 Z" fill="url(#${gradId})"/><path d="M55 70 L65 60 L75 80 L85 70" stroke="${palette.accent}" stroke-width="6" fill="none" opacity="0.7"/></svg>`;
    } else if (industry === 'healthcare') { // Modern, rounded cross
        return `<svg viewBox="0 0 100 100" width="40" height="40" xmlns="http://www.w3.org/2000/svg">${linearGradient}<path d="M42 20 H58 V42 H80 V58 H58 V80 H42 V58 H20 V42 H42 Z" fill="url(#${gradId})" rx="4" ry="4"/></svg>`;
    } else if (industry === 'crypto') { // Layered, glowing crystal
        return `<svg viewBox="0 0 100 100" width="40" height="40" xmlns="http://www.w3.org/2000/svg">${linearGradient}<defs><filter id="glow"><feGaussianBlur stdDeviation="3.5" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><polygon points="50,5 95,50 50,95 5,50" fill="none" stroke="url(#${gradId})" stroke-width="5" filter="url(#glow)"/><polygon points="50,15 85,50 50,85 15,50" fill="${palette.accent}" opacity="0.6"/></svg>`;
    } else if (industry === 'food') { // Stylized leaf/utensil
        return `<svg viewBox="0 0 100 100" width="40" height="40" xmlns="http://www.w3.org/2000/svg">${linearGradient}<path d="M50 10 C 80 20, 80 80, 50 90 C 20 80, 20 20, 50 10 Z" fill="url(#${gradId})" opacity="0.8"/><path d="M50 15 C 70 25, 70 70, 50 85" fill="none" stroke="${palette.accent}" stroke-width="6"/><path d="M50 15 C 30 25, 30 70, 50 85" fill="none" stroke="${palette.accent}" stroke-width="6"/></svg>`;
    } else if (industry === 'education') { // Stylized open book/torch
        return `<svg viewBox="0 0 100 100" width="40" height="40" xmlns="http://www.w3.org/2000/svg">${linearGradient}<path d="M50 20 L10 40 V 80 H 90 V 40 L 50 20 Z M 50 25 L 80 40 L 50 55 L 20 40 Z" fill="url(#${gradId})"/><path d="M15 75 L 85 75" stroke="#fff" stroke-width="5" opacity="0.5"/></svg>`;
    } else { // Default fallback
        const radialGradient = `<defs><radialGradient id="${gradId}"><stop offset="0%" stop-color="${palette.accent}" /><stop offset="100%" stop-color="${palette.primary}" stop-opacity="0.9" /></radialGradient></defs>`;
        return `<svg viewBox="0 0 100 100" width="40" height="40" xmlns="http://www.w3.org/2000/svg">${radialGradient}<circle cx="50" cy="50" r="40" fill="url(#${gradId})"/><circle cx="50" cy="50" r="20" fill="#fff"/></svg>`;
    }
}

export function extractBrandDNA(semantics: DesignSemantics): BrandDNA {
    // Override Colors if AI explicitly provided them based on user constraints
    let palette = semantics.custom_colors;
    let safeIndustry = semantics.industry.toLowerCase();
    
    if (!palette) {
        safeIndustry = INDUSTRY_PALETTES[safeIndustry] ? safeIndustry : 'default';
        const mode = semantics.palette_mood.includes('dark') ? 'dark' : 'light';
        palette = INDUSTRY_PALETTES[safeIndustry][mode];
    }
    
    // Override Fonts if AI explicitly provided them
    let fontPair = semantics.custom_font ? { display: semantics.custom_font, body: semantics.custom_font } : FONT_PAIRS['default'];
    if (!semantics.custom_font) {
        let fontKey = 'default';
        for (const key of Object.keys(FONT_PAIRS)) {
            if (semantics.typography_feel.toLowerCase().includes(key)) { fontKey = key; break; }
        }
        fontPair = FONT_PAIRS[fontKey];
    }
    
    // NEW: Border Radius Logic
    const cornerStyle = semantics.corner_style || 'default';
    const borderRadius = BORDER_RADII[cornerStyle] || BORDER_RADII.default;
    
    const safePalette = palette!;
    const logoSVG = generateLogoSVG(safeIndustry, safePalette);
    const spacing = SPACING[semantics.layout as keyof typeof SPACING] || SPACING.default;
    
    const cssVars = [
        `--brand-primary: ${safePalette.primary};`,
        `--brand-accent: ${safePalette.accent};`,
        `--brand-surface: ${safePalette.surface};`,
        `--font-display: '${fontPair.display}', sans-serif;`,
        `--font-body: '${fontPair.body}', sans-serif;`,
        `--brand-radius: ${borderRadius};`
    ].join('\n');

    return { palette: safePalette, fontPair, logoSVG, spacing, borderRadius, cssVars };
}

export function orchestrateAssets(semantics: DesignSemantics): Record<string, string> {
    const { industry, emotion, sections } = semantics;
    const assets: Record<string, string> = {};
    const seed = Math.floor(Math.random() * 10000); // A random seed for the session
    
    // Use Unsplash Source for theme-aware images. It's free and requires no API key.
    const queryParams = `${encodeURIComponent(industry)},${encodeURIComponent(emotion || industry)}`;
    
    assets['hero_image'] = `https://source.unsplash.com/1600x900/?${queryParams}&sig=${seed}`;
    
    sections.forEach((sec, idx) => {
        const sectionQuery = `${queryParams},${encodeURIComponent(sec)}`;
        if (sec === 'testimonials' || sec === 'team' || sec === 'reviews') {
            // Pravatar is good for deterministic avatars
            assets[`avatar_${sec}_1`] = `https://i.pravatar.cc/150?u=${seed + idx}1`;
            assets[`avatar_${sec}_2`] = `https://i.pravatar.cc/150?u=${seed + idx}2`;
            assets[`avatar_${sec}_3`] = `https://i.pravatar.cc/150?u=${seed + idx}3`;
        } else {
            // Use Unsplash for other section images too, with more specific keywords
            assets[`image_${sec}`] = `https://source.unsplash.com/800x600/?${sectionQuery}&sig=${seed + idx}`;
        }
    });
    
    return assets;
}