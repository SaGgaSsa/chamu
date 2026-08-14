---
name: Chamu
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#3a3939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#b9cbbc'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#849587'
  outline-variant: '#3b4b3f'
  surface-tint: '#00e38a'
  primary: '#f3fff3'
  on-primary: '#00391f'
  primary-container: '#00ff9c'
  on-primary-container: '#007142'
  inverse-primary: '#006d40'
  secondary: '#a6c8ff'
  on-secondary: '#00315f'
  secondary-container: '#3192fc'
  on-secondary-container: '#002a53'
  tertiary: '#fcfbff'
  on-tertiary: '#273143'
  tertiary-container: '#d5dff7'
  on-tertiary-container: '#586277'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#56ffa7'
  primary-fixed-dim: '#00e38a'
  on-primary-fixed: '#002110'
  on-primary-fixed-variant: '#00522f'
  secondary-fixed: '#d5e3ff'
  secondary-fixed-dim: '#a6c8ff'
  on-secondary-fixed: '#001c3b'
  on-secondary-fixed-variant: '#004786'
  tertiary-fixed: '#d9e3fb'
  tertiary-fixed-dim: '#bdc7de'
  on-tertiary-fixed: '#111c2d'
  on-tertiary-fixed-variant: '#3d475a'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  display-lg:
    fontFamily: JetBrains Mono
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: JetBrains Mono
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-sm:
    fontFamily: JetBrains Mono
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.2'
  body-lg:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  body-sm:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.5'
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  container-max: 1200px
  gutter: 16px
---

## Brand & Style
The design system is engineered for developers who demand high-focus environments and technical precision. The brand personality is "The Silent Partner"—unobtrusive, highly functional, and reliable.

The visual style is a fusion of **Minimalism** and **Technical Glassmorphism**. It mimics the aesthetic of a premium IDE (Integrated Development Environment), utilizing deep monochromatic layers to minimize cognitive load. The emotional response should be one of "Deep Flow"—the interface disappears, leaving only the user's voice and their code/text. Surfaces are defined by subtle glass effects and razor-sharp borders rather than heavy shadows, ensuring the UI feels lightweight and digitally native.

## Colors
The color strategy prioritizes legibility and state signaling within a low-light environment.

- **Backgrounds:** The foundation is a pure Deep Charcoal (#0A0A0A). Secondary layers use a slightly lifted Obsidian (#141414).
- **Accents:** "Cyber Green" (#00FF9C) is the primary action color, used for "Live" dictation states and success indicators. "Electric Blue" (#2E90FA) serves as the secondary accent for selection, focus, and navigation.
- **System States:** Warning states use a desaturated Amber, and Errors use a high-chroma Crimson to ensure they pierce through the dark interface.
- **Text:** High-contrast White (#FFFFFF) for primary content, with muted Slate Grays for metadata and secondary labels to maintain hierarchy.

## Typography
The typography system uses a dual-font approach to balance technical precision with readability.

**JetBrains Mono** is utilized for headlines, labels, and status indicators to reinforce the developer-centric nature of the app. **Geist** is used for body copy and long-form transcriptions to provide a clean, neutral reading experience that remains legible during long sessions.

For mobile, `display-lg` scales down to 32px to prevent horizontal overflow while maintaining its impactful weight. All monospace elements should utilize "Contextual Alternates" and "Ligatures" to enhance the coding-style aesthetic.

## Layout & Spacing
The layout follows a **Rigid Grid System** based on a 4px baseline, mirroring the structure of a code editor's indentation.

- **Desktop:** A fixed-width central container (1200px) is preferred for transcriptions to prevent line lengths from becoming unreadable. Side panels (settings, history) should be docked with clear vertical borders.
- **Mobile:** A fluid single-column layout with 20px side margins.
- **Rhythm:** Use "md" (16px) for most component spacing and "lg" (24px) for section margins.
- **Safe Areas:** Ensure a "Bottom Sheet" area for dictation controls on mobile, keeping them within the thumb-zone while maintaining a 16px buffer from the home indicator.

## Elevation & Depth
In this design system, depth is communicated through **Translucency and Borders** rather than shadows.

- **Tiers:** Level 0 is the base background (#0A0A0A). Level 1 is the "Surface" container—using a 40% opacity glass effect with a 20px backdrop blur.
- **Borders:** Every container must have a 1px solid border. Active containers use the Primary color at 30% opacity; inactive containers use a "Ghost Border" (#FFFFFF at 10% opacity).
- **Active State:** When dictating, the active container should gain a subtle outer glow (0px 0px 15px) using the Primary color at low opacity to simulate a "powered-on" hardware feel.

## Shapes
The shape language is "Soft-Industrial." While the app is technical, purely sharp corners can feel aggressive.

A **Soft** (0.25rem) radius is applied to standard UI components like inputs and buttons. This provides a subtle nod to modern hardware design. Larger containers (cards, modals) use **rounded-lg** (0.5rem) to distinguish them from functional elements. Icons should follow a 2pt stroke weight with "Square" caps to align with the typography.

## Components

### Dictation Controls (The Core)
- **Hold to Speak:** A large, circular button with a 2px Cyber Green border. When held, a "Pulse" animation radiates outward, and the center fills with a low-opacity green glow.
- **Toggle Speak:** A "Record" icon that transforms into a "Stop" square. When active, a small "REC" label in `label-caps` typography blinks in the top right of the button area.

### Buttons
- **Primary:** Solid background (Electric Blue), White text (JetBrains Mono Bold).
- **Ghost:** 1px border (#FFFFFF at 20%), no fill. Becomes solid on hover.

### Input Fields
- Styled like an editor line. Use a vertical bar cursor (Primary color). The label should be positioned above the field in `code-sm` grey text.

### Chips & Tags
- Used for "Technical Tags" (e.g., `.md`, `.js`, `Voice Command`). These are rectangular with 2px radius and a monospace font.

### Cards
- Transparent backgrounds with a 1px border. On hover, the background opacity increases slightly (from 0% to 5% White) to indicate interactivity.

### Visual Feedback
- **Audio Waveform:** A minimalist 1px line-style waveform that appears only during active dictation, rendered in Cyber Green. It should be centered and unobtrusive.
