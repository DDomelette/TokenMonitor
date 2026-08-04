# Component Visibility Plan Amendment

During Task 2 review, the initial plan was found to have one incomplete preservation path.

GridStack serializes only rendered nodes. If a component is hidden by settings, a later drag or resize of another visible component would produce a saved item list without the hidden component. Passing that list directly to `validateLayout()` would restore the missing component at its registry default, losing its prior geometry.

The implementation therefore adds and tests `mergeLayoutItems(existingItems, savedItems)` before layout validation. The merge replaces geometry for rendered/saved IDs and copies untouched records for all non-rendered IDs, including modules hidden by settings and quota modules whose provider is unavailable.

This amendment remains within Issue #2 and is required to satisfy the accepted criterion that hiding and re-enabling a module preserves its position and size.
