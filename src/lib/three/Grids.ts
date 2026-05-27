import * as THREE from 'three';

/**
 * Stacked horizontal reference grids on the ecliptic XZ plane. Each plane
 * follows the camera's XZ position so the grid pattern feels infinite
 * regardless of mesh size. Grid lines are drawn procedurally in the
 * fragment shader at integer-parsec intervals with a radial fade.
 *
 * Central plane (y=0) is solid; offset planes (±dy) are dashed and
 * dimmer. Modeled on the gaia-mary spatial reference.
 */

export interface GridsOptions {
	/** Vertical offset between adjacent planes, in parsec. */
	planeSpacing?: number;
	/** Number of planes above and below the central one (total = 2n+1). */
	offsetCount?: number;
	/** Visible radius around the camera, in parsec. */
	radius?: number;
	/** Spacing between major grid lines, in parsec. */
	gridStep?: number;
	/** Grid colour. */
	color?: THREE.ColorRepresentation;
}

export interface GridsHandle {
	group: THREE.Group;
	/** Re-anchor planes under the current camera XZ position. */
	update: (camera: THREE.Camera) => void;
	dispose: () => void;
}

export function makeGrids(opts: GridsOptions = {}): GridsHandle {
	const planeSpacing = opts.planeSpacing ?? 3;
	const offsetCount = opts.offsetCount ?? 1;
	const radius = opts.radius ?? 12;
	const gridStep = opts.gridStep ?? 1;
	const color = new THREE.Color(opts.color ?? 0xe4f6ee);

	const group = new THREE.Group();
	const planes: { mesh: THREE.Mesh; material: THREE.ShaderMaterial; y: number }[] = [];

	// Single shared geometry — a square in the XZ plane (rotated XY quad).
	// Size = 2*radius so the visible disc fits inside.
	const geom = new THREE.PlaneGeometry(radius * 2, radius * 2);
	geom.rotateX(-Math.PI / 2); // XZ plane, normal +Y

	const range = -offsetCount;
	for (let n = -offsetCount; n <= offsetCount; n++) {
		const isCenter = n === 0;
		// Opacity fade for outer planes — central is full, each step out drops
		// noticeably so the stack reads as "central plane, with hints above/below".
		const opacity = isCenter ? 0.55 : Math.max(0.05, 0.55 - 0.32 * Math.abs(n));
		const material = new THREE.ShaderMaterial({
			uniforms: {
				uCenter: { value: new THREE.Vector2(0, 0) }, // tracks camera XZ
				uRadius: { value: radius },
				uGridStep: { value: gridStep },
				uColor: { value: color },
				uOpacity: { value: opacity },
				uDashed: { value: isCenter ? 0 : 1 }
			},
			vertexShader: /* glsl */ `
				varying vec3 vWorldPos;
				void main() {
					vec4 wp = modelMatrix * vec4(position, 1.0);
					vWorldPos = wp.xyz;
					gl_Position = projectionMatrix * viewMatrix * wp;
				}
			`,
			fragmentShader: /* glsl */ `
				varying vec3 vWorldPos;
				uniform vec2 uCenter;
				uniform float uRadius;
				uniform float uGridStep;
				uniform vec3 uColor;
				uniform float uOpacity;
				uniform int uDashed;

				// Grid: signed distance from nearest gridline along x and z.
				// Use fwidth to keep line width ~1px at any zoom.
				float gridLine(float coord, float step) {
					float f = abs(fract(coord / step - 0.5) - 0.5) * step;
					float w = fwidth(coord) * 1.0;
					return 1.0 - smoothstep(0.0, w, f);
				}

				void main() {
					vec2 xz = vWorldPos.xz;
					float gx = gridLine(xz.x, uGridStep);
					float gz = gridLine(xz.y, uGridStep); // .y here is world z
					// vWorldPos.xz: .x is world x, .y is world z (because vec2 swizzle)
					float g = max(gx, gz);

					// Dash the offset planes: only show every other gridline section.
					if (uDashed == 1) {
						// Repeating square pattern: visible in (cell mod 2 == 0)
						vec2 cell = floor(xz / uGridStep);
						float parity = mod(cell.x + cell.y, 2.0);
						g *= parity;
					}

					// Radial fade from camera-projected centre.
					float r = distance(xz, uCenter);
					float fade = 1.0 - smoothstep(uRadius * 0.55, uRadius * 1.0, r);

					float a = g * fade * uOpacity;
					if (a < 0.003) discard;
					gl_FragColor = vec4(uColor, a);
				}
			`,
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide
		});

		const mesh = new THREE.Mesh(geom, material);
		const y = n * planeSpacing;
		mesh.position.y = y;
		mesh.renderOrder = -1; // draw before stars/markers
		group.add(mesh);
		planes.push({ mesh, material, y });
	}

	const update = (camera: THREE.Camera) => {
		const cx = camera.position.x;
		const cz = camera.position.z;
		for (const p of planes) {
			p.mesh.position.x = cx;
			p.mesh.position.z = cz;
			p.material.uniforms.uCenter.value.set(cx, cz);
		}
	};

	const dispose = () => {
		for (const p of planes) {
			p.material.dispose();
		}
		geom.dispose();
	};

	return { group, update, dispose };
}
