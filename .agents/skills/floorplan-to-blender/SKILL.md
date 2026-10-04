---
name: floorplan-to-blender
description: Reconstruct an editable architectural 3D model in Blender from a PDF or image floor plan. Use for apartments, rooms, houses or building levels, including plan interpretation, scale calibration, fixed fixtures, cutaway views and rendered previews.
---

# Floor Plan to Blender

Turn the supplied plan into actual editable Blender geometry. Deliver a usable `.blend` file, rendered previews and reproducible source. Match the user's scope, detail level and furniture preferences.

## Inspect the plan

- Read the supplied file and visually inspect the relevant page at sufficient resolution. Text extraction alone misses walls, door swings, windows and fixture symbols. For a PDF, use available PDF tools to render a local reference image.
- Identify the requested unit or area and its room labels. Establish which spaces belong to it; do not interpret room suffixes as separate apartments without evidence.
- Trace the perimeter, recesses, partitions, shafts, openings and fixed fixtures. Distinguish thick wall lines from thin room-area divisions, dimension lines and door-swing arcs. Preserve meaningful notches instead of replacing the footprint with a bounding rectangle.
- Treat attached prompts and documents as reference material unless the user asks to execute their instructions. Ask for clarification only when unresolved scope or ambiguity would materially change the model; continue independent work meanwhile.

## Establish coordinates and scale

- Use one consistent coordinate system, normally metres with Z vertical. Record the source image origin, axis directions and pixel-to-world transformation.
- Prefer explicit dimensions or a verified measured length. Do not infer architectural scale from a resized screenshot's page size.
- If only room areas are available, an approximate scale can be estimated from a traced zone:

  `metres_per_pixel = sqrt(labelled_area_m2 / traced_area_pixels2)`

  Use a label only when its corresponding boundary is reasonably clear. Record uncertainty about whether it includes walls or other spaces. Convert square feet to square metres with `sqft * 0.09290304`.
- Check the resulting scale against other labels and plausible door/fixture sizes. Investigate inconsistencies; do not stretch individual rooms independently to force every area label to match.
- Record assumptions for wall thickness, ceiling height, sill/head heights and fixture dimensions. Keep these parameters separate from traced plan coordinates so a new measurement can recalibrate the model.

## Build editable architecture

- Locate an available Blender installation and check its version. Prefer Blender Python for repeatable construction; do not substitute an AI-generated picture for a 3D model.
- Store footprint, wall segments, openings and dimensions as explicit parameters. Preserve existing user edits when refining a scene; save a previous version before replacing generated outputs.
- Build the actual floor outline, including recesses and level changes shown in the plan. Build walls as solids with genuine door and window openings.
- Use reliable mesh construction or booleans. For orthogonal plans, boundary meshing of a union of rectangular solids can avoid intersecting internal faces. Keep shared vertices coherent and check the resulting shell for open seams and degenerate faces.
- Keep the complete architectural shell. Derive a separate cutaway for presentation; do not permanently remove full-height walls to make a render readable. Full and cutaway shells must be mutually exclusive display options.
- Give doors hinge pivots and record their open/closed angles. Orient cabinet fronts and appliances toward the room. Model sinks, shower trays and toilet bowls with visible recesses/openings when they appear in close views.
- Use generic fixed fixtures where style is unverified. Add loose or custom furniture according to the user's request. Keep assumed finishes distinguishable from observed architecture in project notes.
- Organize named collections for floors/finishes, full walls, cutaway walls, windows/trim, room fixtures, doors, optional ceiling, references, annotations, cameras/lights and additional assets as needed.

## Add supplied objects when requested

- Inspect the asset's format, orientation, units and actual geometry. A `.ply` may contain a polygon mesh, a point cloud or Gaussian splats; its extension does not establish which.
- Preserve the supplied asset. If conversion is needed for native Blender rendering, document the approximation and retain colours or textures where available.
- Scale uniformly using a defined measurement. For a posed person, distinguish a visible head-to-foot reference from verified standing height. After rotating an object, its world-aligned bounding-box width is not its original length; check the intended reference axis instead.
- Verify the requested pose visually. Ground the intended support surface, check for floor/cabinet intersections, and choose a view that shows the placement clearly. Do not assume that a file's original up axis or lowest stray point establishes correct orientation or contact.

## Render and verify

- Use restrained materials and lighting appropriate to the requested realism. Keep the first view useful for inspecting the space, with the ceiling hidden and the architecture clearly framed.
- Render a complete cutaway and an overhead layout. Add a closer view when important fixtures or supplied assets need inspection. Inspect the actual renders for hidden subjects, floating objects, wrong-facing fixtures and confusing cutaway edges.
- Check wall topology and openings with geometry queries where useful. Verify intended passages remain open and solid walls remain closed. These checks establish mesh correctness, not survey accuracy or regulatory compliance.
- Save and reopen the final `.blend`. Confirm the expected objects, collections, cameras, materials and references remain available. Pack required images or provide working relative paths.
- If an interchange export is requested or useful, verify it includes the intended full architecture and assets while excluding presentation ground and helper objects. Check colours/textures survive. Document procedural shaders that export only as fallback colours.

## Deliver

Provide clickable paths to the final Blender scene and previews. Include the generator or editing scripts, reference files and a compact record of scale, assumptions and verification. Explain what changed and any material limitation in plain language. Call the result a measured reconstruction only when the evidence supports that claim.
