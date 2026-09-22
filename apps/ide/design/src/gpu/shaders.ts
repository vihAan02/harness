// WGSL for the prototype's shader components. uv is top-left origin (vgpu convention).

const NOISE = /* wgsl */ `
fn hash(q: vec2f) -> f32 { return fract(sin(dot(q, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise(q: vec2f) -> f32 {
  let i = floor(q);
  let f = fract(q);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x),
             mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(q0: vec2f) -> f32 {
  var q = q0;
  var a = 0.5;
  var s = 0.0;
  for (var i = 0; i < 4; i++) {
    s += a * noise(q);
    q = q * 2.03 + vec2f(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}
`

/** A lit, swirling sphere of light: one per agent. energy 0..1 sets speed and glow. */
export const ORB = /* wgsl */ `
struct P { time: f32, energy: f32, seed: f32, pulse: f32, color: vec4f, deep: vec4f }
@group(0) @binding(0) var<uniform> p: P;
${NOISE}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = (uv - 0.5) * 2.0;
  let r = length(c);
  let t = p.time * (0.2 + p.energy * 0.9) + p.seed * 17.0;
  let breathe = 1.0 + p.pulse * 0.05 * sin(p.time * 3.2 + p.seed);
  let R = 0.6 * breathe;
  let z = sqrt(max(R * R - r * r, 0.0)) / R;
  let n = vec3f(c / R, z);
  let warp = vec2f(fbm(c * 2.4 + vec2f(t * 0.35, -t * 0.2)), fbm(c * 2.4 + vec2f(-t * 0.25, t * 0.3) + 4.0));
  let f = fbm(c * 1.8 + warp * 1.6 + vec2f(sin(t * 0.4), cos(t * 0.3)));
  let light = clamp(dot(n, normalize(vec3f(-0.45, -0.55, 0.7))), 0.0, 1.0);
  var col = mix(p.deep.rgb, p.color.rgb, smoothstep(0.3, 0.8, f)) * (0.3 + 0.95 * light);
  col += vec3f(pow(light, 22.0) * 0.55);
  let rim = pow(1.0 - z, 2.5);
  col += p.color.rgb * rim * (0.5 + 0.6 * p.energy);
  let edge = smoothstep(R + 0.015, R - 0.015, r);
  let glow = exp(-7.0 * max(r - R, 0.0)) * (0.12 + 0.45 * p.energy) * (1.0 - edge);
  let a = clamp(edge + glow, 0.0, 1.0);
  return vec4f(col * edge + p.color.rgb * glow, a);
}
`

/** Prism: a black field lit by one pool of spectral light per agent, with drifting caustics. */
export const FIELD = /* wgsl */ `
struct F {
  time: f32, aspect: f32, grain: f32, pad: f32,
  l0: vec4f, l1: vec4f, l2: vec4f, l3: vec4f, l4: vec4f,
  c0: vec4f, c1: vec4f, c2: vec4f, c3: vec4f, c4: vec4f,
}
@group(0) @binding(0) var<uniform> f: F;
${NOISE}
fn pool(uv: vec2f, l: vec4f, c: vec4f, t: f32) -> vec3f {
  let drift = vec2f(sin(t * 0.21 + l.w * 6.0), cos(t * 0.17 + l.w * 4.0)) * 0.012;
  var d = uv - l.xy - drift;
  d.x *= f.aspect;
  let r2 = dot(d, d);
  let core = 0.0009 / (r2 + 0.0009);
  let halo = exp(-r2 * 9.0);
  let caustic = fbm(vec2f(atan2(d.y, d.x) * 2.5, sqrt(r2) * 9.0 - t * 0.5) + l.w * 3.0);
  return c.rgb * l.z * (core * 0.35 + halo * (0.16 + 0.22 * caustic));
}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = f.time;
  var col = pool(uv, f.l0, f.c0, t) + pool(uv, f.l1, f.c1, t) + pool(uv, f.l2, f.c2, t)
          + pool(uv, f.l3, f.c3, t) + pool(uv, f.l4, f.c4, t);
  // faint spectral beam across the field, like light through a prism
  let beam = exp(-pow((uv.y - 0.5 - (uv.x - 0.5) * 0.18) * 7.0, 2.0)) * 0.035;
  let hue = uv.x * 6.28318 + t * 0.05;
  col += beam * (0.5 + 0.5 * cos(vec3f(hue, hue - 2.1, hue - 4.2)));
  let vig = smoothstep(1.25, 0.25, length((uv - 0.5) * vec2f(f.aspect * 0.8, 1.0)));
  col *= vig;
  col += (hash(uv * 900.0 + t) - 0.5) * f.grain;
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
`
